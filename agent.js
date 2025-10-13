const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= CONFIGURATION =======
const DEVICE_ID = 'RVM-3101';
const LOCAL_API_BASE = 'http://localhost:8081';
const WS_URL = 'ws://localhost:8081/websocket/qazwsx1234';

// MQTT Configuration
const MQTT_BROKER_URL = 'mqtts://mqtt.ceewen.xyz:8883';
const MQTT_USERNAME = 'mqttuser';
const MQTT_PASSWORD = 'mqttUser@2025';
const MQTT_CA_FILE = 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle';

// Store moduleId and latest AI detection result
let currentModuleId = null;
let latestAIResult = null;
let latestWeight = null;
let pendingCommands = new Map();

// ======= WEBSOCKET CONNECTION =======
let ws = null;

function connectWebSocket() {
  console.log(`🔌 Attempting to connect to WebSocket: ${WS_URL}`);
  
  ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected to RVM');
  });
  
  ws.on('message', (data) => {
    try {
      console.log('\n📩 WebSocket message:', data.toString());
      const message = JSON.parse(data);
      
      // Skip connection success message
      if (message.msg === '连接成功' || message.msg === 'connection successful') {
        console.log('✅ WebSocket connection confirmed');
        return;
      }
      
      // Handle getModuleId response (function: "01")
      if (message.function === '01') {
        currentModuleId = message.moduleId;
        console.log(`✅ Module ID: ${currentModuleId}`);
        
        if (pendingCommands.size > 0) {
          const [commandId, commandData] = Array.from(pendingCommands.entries())[0];
          executePendingCommand(commandData);
          pendingCommands.delete(commandId);
        }
        return;
      }
      
      // Handle AI Photo Result (function: "aiPhoto")
      if (message.function === 'aiPhoto') {
        latestAIResult = {
          matchRate: message.data,
          materialType: determineMaterialType(message),
          rawData: message,
          timestamp: new Date().toISOString()
        };
        
        console.log('🤖 AI Detection Result:');
        console.log(`   Match Rate: ${latestAIResult.matchRate}%`);
        console.log(`   Material: ${latestAIResult.materialType}`);
        console.log(`   Raw Data: ${JSON.stringify(message)}`);
        
        // Publish AI result to MQTT
        const aiTopic = `rvm/${DEVICE_ID}/ai_result`;
        mqttClient.publish(aiTopic, JSON.stringify(latestAIResult));
      }
      
      // Handle Weight Result (function: "06")
      if (message.function === '06') {
        latestWeight = {
          weight: parseFloat(message.data) || 0,
          timestamp: new Date().toISOString()
        };
        
        console.log(`⚖️ Weight: ${latestWeight.weight}g`);
        
        // Publish weight to MQTT
        const weightTopic = `rvm/${DEVICE_ID}/weight_result`;
        mqttClient.publish(weightTopic, JSON.stringify(latestWeight));
      }
      
      // Publish all WebSocket events to MQTT
      const eventTopic = `rvm/${DEVICE_ID}/events`;
      mqttClient.publish(eventTopic, JSON.stringify({
        deviceId: DEVICE_ID,
        function: message.function || 'unknown',
        data: message.data || message,
        rawMessage: message,
        timestamp: new Date().toISOString()
      }));
      
    } catch (err) {
      console.error('❌ WebSocket parse error:', err.message);
    }
  });
  
  ws.on('close', () => {
    console.log('⚠️ WebSocket closed, reconnecting in 5s...');
    setTimeout(connectWebSocket, 5000);
  });
  
  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });
}

// ======= DETERMINE MATERIAL TYPE FROM AI RESULT =======
function determineMaterialType(aiMessage) {
  // This function interprets the AI result to determine material type
  // You may need to adjust this based on actual AI response format
  
  const matchRate = parseInt(aiMessage.data) || 0;
  
  // Check if there's additional data in the message
  if (aiMessage.materialType) {
    return aiMessage.materialType;
  }
  
  // If match rate is high enough, try to determine from other fields
  if (matchRate >= 70) {
    // Check for material indicators in the raw data
    const rawData = JSON.stringify(aiMessage).toLowerCase();
    
    if (rawData.includes('pet') || rawData.includes('plastic') || rawData.includes('bottle')) {
      return 'PLASTIC_BOTTLE';
    } else if (rawData.includes('metal') || rawData.includes('can') || rawData.includes('aluminum')) {
      return 'METAL_CAN';
    }
  }
  
  // Default: if match rate is high, assume plastic, otherwise unknown
  if (matchRate >= 70) {
    return 'PLASTIC_BOTTLE';  // Default assumption
  } else {
    return 'UNKNOWN';
  }
}

// ======= GET MODULE ID =======
async function getModuleId() {
  try {
    console.log('🔍 Getting Module ID...');
    await axios.post(`${LOCAL_API_BASE}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('⏳ Waiting for WebSocket response...');
  } catch (err) {
    console.error('❌ Failed to get module ID:', err.message);
    throw err;
  }
}

// ======= EXECUTE COMMAND =======
async function executePendingCommand(commandData) {
  const { action, params } = commandData;
  
  if (!currentModuleId) {
    console.error('❌ No moduleId available!');
    return;
  }
  
  let apiUrl;
  let apiPayload;
  
  console.log(`🔄 Processing: ${action}`);
  
  // Special handling for auto-stepper (uses latest AI result)
  if (action === 'stepperAuto') {
    if (!latestAIResult) {
      console.error('❌ No AI result available for auto stepper positioning');
      return;
    }
    
    let stepperPosition;
    switch (latestAIResult.materialType) {
      case 'PLASTIC_BOTTLE':
        stepperPosition = '03';  // Position for plastic bottle
        break;
      case 'METAL_CAN':
        stepperPosition = '02';  // Position for metal can
        break;
      default:
        stepperPosition = '01';  // Return to origin for unknown
    }
    
    console.log(`🎯 Auto-positioning stepper to: ${stepperPosition} (${latestAIResult.materialType})`);
    
    apiUrl = `${LOCAL_API_BASE}/system/serial/stepMotorSelect`;
    apiPayload = { moduleId: '0F', type: stepperPosition, deviceType: 1 };
  }
  // Motor control commands
  else if (action === 'openGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '01', type: '03', deviceType: 1 };
  } 
  else if (action === 'closeGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '01', type: '00', deviceType: 1 };
  }
  else if (action === 'transferForward') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '02', type: '02', deviceType: 1 };
  }
  else if (action === 'transferReverse') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '02', type: '01', deviceType: 1 };
  }
  else if (action === 'transferStop') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '02', type: '00', deviceType: 1 };
  }
  else if (action === 'transferToCollectBin') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '03', type: '03', deviceType: 1 };
  }
  else if (action === 'compactorStart') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '04', type: '01', deviceType: 1 };
  }
  else if (action === 'compactorStop') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '04', type: '00', deviceType: 1 };
  }
  else if (action === 'getWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/getWeight`;
    apiPayload = { moduleId: '06', type: '00' };
  }
  else if (action === 'calibrateWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/weightCalibration`;
    apiPayload = { moduleId: '07', type: '00' };
  }
  else if (action === 'takePhoto') {
    apiUrl = `${LOCAL_API_BASE}/system/camera/process`;
    apiPayload = {};
  }
  else if (action === 'stepperMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/stepMotorSelect`;
    apiPayload = { moduleId: '0F', type: params?.position || '00', deviceType: 1 };
  }
  else if (action === 'multipleMotors') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/testAllMotor`;
    apiPayload = {
      time: params?.initialDelay || 1000,
      list: params?.motorActions || []
    };
  }
  else if (action === 'customMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = {
      moduleId: params?.moduleId || currentModuleId,
      motorId: params?.motorId,
      type: params?.type,
      deviceType: params?.deviceType || 1
    };
  }
  else {
    console.error('⚠️ Unknown action:', action);
    return;
  }
  
  console.log(`🔗 Calling: ${apiUrl}`);
  console.log(`📦 Payload:`, JSON.stringify(apiPayload, null, 2));
  
  try {
    const result = await axios.post(apiUrl, apiPayload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log(`✅ Success: ${result.status}`);
    
    // Include AI and weight data in response if available
    const responseData = {
      command: action,
      success: true,
      result: result.data,
      moduleId: currentModuleId,
      timestamp: new Date().toISOString()
    };
    
    if (action === 'stepperAuto' || action === 'stepperMotor') {
      responseData.aiResult = latestAIResult;
    }
    
    if (action === 'getWeight') {
      responseData.weight = latestWeight;
    }
    
    const responseTopic = `rvm/${DEVICE_ID}/responses`;
    mqttClient.publish(responseTopic, JSON.stringify(responseData));
    
  } catch (apiError) {
    console.error('❌ API Error:', apiError.message);
    
    const responseTopic = `rvm/${DEVICE_ID}/responses`;
    mqttClient.publish(responseTopic, JSON.stringify({
      command: action,
      success: false,
      error: apiError.message,
      timestamp: new Date().toISOString()
    }));
  }
}

// ======= MQTT CLIENT =======
const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  ca: fs.readFileSync(MQTT_CA_FILE),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  console.log('✅ Connected to MQTT Broker');
  
  mqttClient.subscribe(`rvm/${DEVICE_ID}/commands`, (err) => {
    if (!err) console.log(`📡 Subscribed to commands`);
  });
  
  connectWebSocket();
  
  setTimeout(async () => {
    try {
      await getModuleId();
    } catch (err) {
      console.error('⚠️ Failed to get moduleId on startup');
    }
  }, 2000);
});

// ======= HANDLE MQTT COMMANDS =======
mqttClient.on('message', async (topic, message) => {
  console.log('\n========================================');
  console.log(`📩 Command: ${message.toString()}`);
  
  try {
    const command = JSON.parse(message.toString());
    
    if (!currentModuleId) {
      console.log('⚠️ No moduleId, fetching first...');
      const commandId = Date.now().toString();
      pendingCommands.set(commandId, command);
      await getModuleId();
    } else {
      console.log(`✅ Using moduleId: ${currentModuleId}`);
      await executePendingCommand(command);
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
  
  console.log('========================================\n');
});

mqttClient.on('error', (err) => {
  console.error('❌ MQTT error:', err.message);
});

process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down...');
  if (ws) ws.close();
  mqttClient.end();
  process.exit(0);
});

console.log('========================================');
console.log('🚀 RVM Agent Started');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('📊 Tracking:');
console.log('  - AI Detection Results → rvm/${DEVICE_ID}/ai_result');
console.log('  - Weight Readings → rvm/${DEVICE_ID}/weight_result');
console.log('========================================\n');