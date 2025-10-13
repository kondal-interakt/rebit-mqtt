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
  
  ws.on('message', async (data) => {
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
        currentModuleId = message.data;  // Fixed: use message.data per doc
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
        try {
          // Parse the nested JSON in the 'data' field
          const aiData = JSON.parse(message.data);
          const probability = aiData.probability || 0;
          const className = aiData.className || '';
          
          latestAIResult = {
            matchRate: Math.round(probability * 100),  // Convert to percentage
            materialType: determineMaterialType(aiData),
            className: className,
            taskId: aiData.taskId,
            rawData: message,
            timestamp: new Date().toISOString()
          };
          
          console.log('🤖 AI Detection Result:');
          console.log(`   Match Rate: ${latestAIResult.matchRate}%`);
          console.log(`   Class Name: ${latestAIResult.className}`);
          console.log(`   Material: ${latestAIResult.materialType}`);
          
          // AUTOMATION: If match rate >= 30% and material identified, auto-proceed
          if (latestAIResult.matchRate >= 30 && latestAIResult.materialType !== 'UNKNOWN') {
            console.log(`🤖 Auto-triggering workflow for ${latestAIResult.materialType}`);
            
            // Step 1: Get weight automatically
            setTimeout(async () => {
              await executePendingCommand({ action: 'getWeight' });
            }, 500);  // Short delay for stability
          } else {
            console.log(`⚠️ AI confidence too low (${latestAIResult.matchRate}%) or unknown material - manual intervention needed`);
            // Optionally publish to MQTT for user alert
            mqttClient.publish(`rvm/${DEVICE_ID}/alerts`, JSON.stringify({
              type: 'low_confidence',
              message: `AI match rate: ${latestAIResult.matchRate}%, Material: ${latestAIResult.materialType}`,
              timestamp: new Date().toISOString()
            }));
          }
          
          // Publish AI result to MQTT
          const aiTopic = `rvm/${DEVICE_ID}/ai_result`;
          mqttClient.publish(aiTopic, JSON.stringify(latestAIResult));
        } catch (parseErr) {
          console.error('❌ Failed to parse AI data:', parseErr.message);
          // Fallback: treat as low confidence unknown
          latestAIResult = {
            matchRate: 0,
            materialType: 'UNKNOWN',
            className: '',
            rawData: message,
            timestamp: new Date().toISOString()
          };
          // Publish fallback
          const aiTopic = `rvm/${DEVICE_ID}/ai_result`;
          mqttClient.publish(aiTopic, JSON.stringify(latestAIResult));
        }
        return;
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
        
        // AUTOMATION: If valid, trigger sequenced motors via testAllMotor
        if (latestAIResult && latestWeight.weight > 50) {
          console.log(`✅ Valid weight detected - triggering sequenced operations`);
          
          let stepperPosition;
          switch (latestAIResult.materialType) {
            case 'PLASTIC_BOTTLE':
              stepperPosition = '03';
              break;
            case 'METAL_CAN':
              stepperPosition = '02';
              break;
            default:
              stepperPosition = '01';
          }
          
          // Define sequence: Stepper → Transfer → Compact Start (5s run) → Compact Stop → Close Gate
          const motorSequence = [
            {
              moduleId: '0F',      // Stepper module
              type: stepperPosition,
              time: 2000           // Wait 2s after stepper positions
            },
            {
              moduleId: currentModuleId,
              motorId: latestAIResult.materialType === 'PLASTIC_BOTTLE' ? '03' : '02',
              type: '03',          // To bin or forward
              time: 3000           // Wait 3s for transfer
            },
            {
              moduleId: currentModuleId,
              motorId: '04',       // Compactor
              type: '01',          // Start
              time: 5000           // Run for 5s, then next auto-stops
            },
            {
              moduleId: currentModuleId,
              motorId: '04',
              type: '00',          // Stop
              time: 1000           // 1s pause
            },
            {
              moduleId: currentModuleId,
              motorId: '01',       // Gate
              type: '00',          // Close
              time: 0              // End sequence
            }
          ];
          
          // Execute the full sequence
          await executePendingCommand({
            action: 'multipleMotors',
            params: {
              initialDelay: 1000,    // 1s before starting
              motorActions: motorSequence
            }
          });
          
          console.log('🏁 Sequenced operations dispatched');
          // Publish completion (monitor WebSocket for final events)
          mqttClient.publish(`rvm/${DEVICE_ID}/cycle_complete`, JSON.stringify({
            material: latestAIResult.materialType,
            weight: latestWeight.weight,
            sequence: 'testAllMotor',
            timestamp: new Date().toISOString()
          }));
          
        } else if (latestWeight.weight <= 50) {
          console.log(`⚠️ Weight too low (${latestWeight.weight}g) - rejecting item`);
          // Optional: Alert or reverse
        }
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
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  const matchRate = Math.round(probability * 100);
  
  // Classify based on className keywords (adjust as needed for your AI model)
  if (className.includes('pet瓶') || className.includes('plastic') || className.includes('瓶')) {
    return 'PLASTIC_BOTTLE';
  } else if (className.includes('易拉罐') || className.includes('metal') || className.includes('can') || className.includes('铝')) {
    return 'METAL_CAN';
  } else if (className.includes('玻璃') || className.includes('glass')) {
    return 'GLASS';
  }
  
  // If no specific match, use probability threshold for default
  if (matchRate >= 50) {  // Threshold for sensitivity
    if (className.includes('瓶') || className.includes('bottle')) {
      return 'PLASTIC_BOTTLE';
    } else {
      return 'METAL_CAN';  // Default for cans
    }
  }
  
  return 'UNKNOWN';
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
  
  if (!currentModuleId && action !== 'getModuleId') {
    console.error('❌ No moduleId available!');
    return;
  }
  
  let apiUrl;
  let apiPayload;
  
  console.log(`🔄 Processing: ${action}`);
  
  // Motor control commands
  if (action === 'openGate') {
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
    
    if (action === 'stepperMotor') {
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