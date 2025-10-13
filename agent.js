// Full RVM Agent Code (agent.js - Runs on RVM Machine)
// Plain JS version - No TypeScript annotations
// Updated: Aligned with official RVM-3101 spec (v1.0.2) and log.
// - Set currentModuleId = message.moduleId from WS response (e.g., "09") instead of message.data (serial).
// - Fallback to message.data if moduleId absent.
// - Use dynamic currentModuleId for motor actions.
// - Retained fixed moduleIds for weight ('06'), calibration ('07'), stepper ('0F') per spec.
// - deviceType fixed to 1 for RVM-3101.

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

// Store moduleId from API and latest results
let currentModuleId = null;  // e.g., "09" from WS moduleId
let latestAIResult = null;
let latestWeight = null;
let pendingCommands = new Map();

// Response waiting mechanism
const commandPromises = new Map();

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
      
      if (message.msg === '连接成功' || message.msg === 'connection successful') {
        console.log('✅ WebSocket connection confirmed');
        return;
      }
      
      // Handle getModuleId response (function: "01")
      if (message.function === '01') {
        currentModuleId = message.moduleId || message.data;  // Prefer moduleId ("09"), fallback to data
        console.log(`✅ Module ID: ${currentModuleId}`);
        
        if (commandPromises.has('getModuleId')) {
          commandPromises.get('getModuleId').resolve(message);
          commandPromises.delete('getModuleId');
        }
        
        if (pendingCommands.size > 0) {
          const [commandId, commandData] = Array.from(pendingCommands.entries())[0];
          await executeCommand(commandData);
          pendingCommands.delete(commandId);
        }
        return;
      }
      
      // Handle AI Photo Result (function: "aiPhoto")
      if (message.function === 'aiPhoto') {
        try {
          const aiData = JSON.parse(message.data);
          const probability = aiData.probability || 0;
          const className = aiData.className || '';
          
          latestAIResult = {
            matchRate: Math.round(probability * 100),
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
          
          const photoCommandId = message.taskId || 'aiPhoto';
          if (commandPromises.has(photoCommandId)) {
            commandPromises.get(photoCommandId).resolve(message);
            commandPromises.delete(photoCommandId);
          }
          
          if (latestAIResult.matchRate >= 30 && latestAIResult.materialType !== 'UNKNOWN') {
            console.log(`🤖 Auto-triggering workflow for ${latestAIResult.materialType}`);
            setTimeout(async () => {
              await executeCommand({ action: 'getWeight' });
            }, 500);
          } else {
            console.log(`⚠️ AI confidence too low (${latestAIResult.matchRate}%) or unknown material`);
            mqttClient.publish(`rvm/${DEVICE_ID}/alerts`, JSON.stringify({
              type: 'low_confidence',
              message: `AI match rate: ${latestAIResult.matchRate}%, Material: ${latestAIResult.materialType}`,
              timestamp: new Date().toISOString()
            }));
          }
          
          const aiTopic = `rvm/${DEVICE_ID}/ai_result`;
          mqttClient.publish(aiTopic, JSON.stringify(latestAIResult));
        } catch (parseErr) {
          console.error('❌ Failed to parse AI data:', parseErr.message);
          latestAIResult = {
            matchRate: 0,
            materialType: 'UNKNOWN',
            className: '',
            rawData: message,
            timestamp: new Date().toISOString()
          };
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
        
        if (commandPromises.has('getWeight')) {
          commandPromises.get('getWeight').resolve(message);
          commandPromises.delete('getWeight');
        }
        
        // Auto-calibrate if invalid (per spec)
        if (latestWeight.weight <= 0) {
          console.log(`⚠️ Invalid weight (${latestWeight.weight}g) - auto-calibrating...`);
          setTimeout(async () => {
            await executeCommand({ action: 'calibrateWeight' });
            setTimeout(async () => {
              await executeCommand({ action: 'getWeight' });
            }, 1000);
          }, 500);
        }
        
        const weightTopic = `rvm/${DEVICE_ID}/weight_result`;
        mqttClient.publish(weightTopic, JSON.stringify(latestWeight));
        
        // Automation
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
          
          const motorSequence = [
            { action: 'stepperMotor', params: { position: stepperPosition } },
            { 
              action: 'customMotor', 
              params: { 
                motorId: latestAIResult.materialType === 'PLASTIC_BOTTLE' ? '03' : '02', 
                type: '03' 
              } 
            },
            { action: 'compactorStart' },
            { delay: 5000 },
            { action: 'compactorStop' },
            { action: 'closeGate' }
          ];
          
          await executeSequence(motorSequence);
          
          console.log('🏁 Sequenced operations completed');
          mqttClient.publish(`rvm/${DEVICE_ID}/cycle_complete`, JSON.stringify({
            material: latestAIResult.materialType,
            weight: latestWeight.weight,
            sequence: 'cycle',
            timestamp: new Date().toISOString()
          }));
          
        } else if (latestWeight.weight <= 50 && latestWeight.weight > 0) {
          console.log(`⚠️ Weight too low (${latestWeight.weight}g) - rejecting item`);
          mqttClient.publish(`rvm/${DEVICE_ID}/alerts`, JSON.stringify({
            type: 'low_weight',
            message: `Weight: ${latestWeight.weight}g`,
            timestamp: new Date().toISOString()
          }));
        }
        return;
      }
      
      // Handle Abnormal (function: "03")
      if (message.function === '03') {
        console.log('🚨 RVM Abnormal Detected:', message.data);
        mqttClient.publish(`rvm/${DEVICE_ID}/alerts`, JSON.stringify({
          type: 'abnormal',
          motors: message.data,
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      // Handle Device Status (function: "deviceStatus")
      if (message.function === 'deviceStatus') {
        const fullCode = parseInt(message.data) || -1;
        const binStatus = [
          'Left bin (PET) full',
          'Middle bin (Metal can) full',
          'Right bin full',
          'Glass bin full',
          'Infrared body sensor'
        ];
        if (fullCode >= 0 && fullCode <= 3) {
          console.log(`🗑️ Bin full: ${binStatus[fullCode]}`);
          mqttClient.publish(`rvm/${DEVICE_ID}/alerts`, JSON.stringify({
            type: 'bin_full',
            code: fullCode,
            description: binStatus[fullCode],
            timestamp: new Date().toISOString()
          }));
        }
        return;
      }
      
      // Generic motor response
      if (message.function === 'motor' || message.function?.startsWith('motor')) {
        const commandId = message.commandId || message.data?.commandId || 'motor';
        if (commandPromises.has(commandId)) {
          commandPromises.get(commandId).resolve(message);
          commandPromises.delete(commandId);
        }
      }
      
      // Publish events
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

// ======= DETERMINE MATERIAL TYPE =======
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  const matchRate = Math.round(probability * 100);
  
  if (className.includes('pet瓶') || className.includes('plastic') || className.includes('瓶')) {
    return 'PLASTIC_BOTTLE';
  } else if (className.includes('易拉罐') || className.includes('metal') || className.includes('can') || className.includes('铝')) {
    return 'METAL_CAN';
  } else if (className.includes('玻璃') || className.includes('glass')) {
    return 'GLASS';
  }
  
  if (matchRate >= 50) {
    if (className.includes('瓶') || className.includes('bottle')) {
      return 'PLASTIC_BOTTLE';
    } else {
      return 'METAL_CAN';
    }
  }
  
  return 'UNKNOWN';
}

// ======= WAIT FOR RESPONSE =======
function waitForResponse(commandId, timeout = 10000) {
  return new Promise((resolve, reject) => {
    commandPromises.set(commandId, { resolve, reject });
    
    setTimeout(() => {
      if (commandPromises.has(commandId)) {
        commandPromises.get(commandId).reject(new Error(`Timeout waiting for ${commandId}`));
        commandPromises.delete(commandId);
      }
    }, timeout);
  });
}

// ======= GET MODULE ID FROM API =======
async function getModuleId() {
  try {
    console.log('🔍 Getting Module ID from API...');
    const commandId = 'getModuleId';
    await axios.post(`${LOCAL_API_BASE}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('⏳ Waiting for WebSocket response...');
    
    const response = await waitForResponse(commandId);
    console.log('✅ Module ID received:', currentModuleId);
    return currentModuleId;
  } catch (err) {
    console.error('❌ Failed to get module ID:', err.message);
    throw err;
  }
}

// ======= EXECUTE COMMAND =======
async function executeCommand(commandData) {
  const { action, params } = commandData;
  const commandId = params?.commandId || `${action}-${Date.now()}`;
  const deviceType = 1;  // Fixed for RVM-3101 per spec section 11
  
  if (!currentModuleId && action !== 'getModuleId') {
    console.error('❌ No moduleId available!');
    return;
  }
  
  let apiUrl;
  let apiPayload = { ...params, commandId };
  
  console.log(`🔄 Processing: ${action} (ID: ${commandId})`);
  
  // Use dynamic currentModuleId for motor actions
  if (action === 'openGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '01', type: '03', deviceType };
  } else if (action === 'closeGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '01', type: '00', deviceType };
  } else if (action === 'transferForward') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '02', type: '02', deviceType };
  } else if (action === 'transferReverse') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '02', type: '01', deviceType };
  } else if (action === 'transferStop') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '02', type: '00', deviceType };
  } else if (action === 'transferToCollectBin') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '03', type: '03', deviceType };
  } else if (action === 'compactorStart') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '04', type: '01', deviceType };
  } else if (action === 'compactorStop') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '04', type: '00', deviceType };
  } else if (action === 'getWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/getWeight`;
    apiPayload = { moduleId: '06', type: '00' };  // Fixed per spec section 5.9
  } else if (action === 'calibrateWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/weightCalibration`;
    apiPayload = { moduleId: '07', type: '00' };  // Fixed per spec section 5.10
  } else if (action === 'takePhoto') {
    apiUrl = `${LOCAL_API_BASE}/system/camera/process`;
    apiPayload = {};
  } else if (action === 'stepperMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/stepMotorSelect`;
    apiPayload = { moduleId: '0F', type: params?.position || '00', deviceType };  // Fixed '0F' per spec section 5.13
  } else if (action === 'multipleMotors') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/testAllMotor`;
    apiPayload = {
      time: params?.initialDelay || 1000,
      list: params?.motorActions.map(m => ({ ...m, moduleId: currentModuleId })) || []  // Use dynamic for list
    };
  } else if (action === 'customMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = {
      moduleId: params?.moduleId || currentModuleId,
      motorId: params?.motorId,
      type: params?.type,
      deviceType
    };
  } else {
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
    
    console.log(`✅ API Success: ${result.status}`);
    
    let wsResponse;
    if (action !== 'getModuleId') {
      wsResponse = await waitForResponse(commandId);
      console.log(`✅ WebSocket response for ${action}:`, wsResponse.data || wsResponse);
    }
    
    const responseData = {
      command: action,
      commandId,
      success: true,
      apiResult: result.data,
      wsResponse: wsResponse?.data || wsResponse,
      moduleId: currentModuleId,
      timestamp: new Date().toISOString()
    };
    
    if (['stepperMotor', 'transferForward', 'transferReverse', 'transferStop', 'transferToCollectBin', 'compactorStart', 'compactorStop', 'openGate', 'closeGate'].includes(action)) {
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
      commandId,
      success: false,
      error: apiError.message,
      timestamp: new Date().toISOString()
    }));
  }
}

// ======= EXECUTE SEQUENTIAL COMMANDS =======
async function executeSequence(sequence) {
  for (let step of sequence) {
    if (step.delay) {
      console.log(`⏳ Delaying ${step.delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, step.delay));
    } else if (step.action) {
      console.log(`🔄 Executing step: ${step.action}`);
      await executeCommand(step);
    }
  }
}

// ======= HANDLE CYCLE START =======
async function handleCycleStart() {
  console.log('🚀 Starting RVM Cycle');
  await executeCommand({ action: 'takePhoto' });
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
      setTimeout(() => getModuleId(), 5000);
    }
  }, 2000);
});

mqttClient.on('message', async (topic, message) => {
  console.log('\n========================================');
  console.log(`📩 Command: ${message.toString()}`);
  
  try {
    const command = JSON.parse(message.toString());
    
    if (command.action === 'cycle/start') {
      await handleCycleStart();
      return;
    }
    
    if (!currentModuleId) {
      console.log('⚠️ No moduleId, fetching first...');
      const commandId = Date.now().toString();
      pendingCommands.set(commandId, command);
      await getModuleId();
    } else {
      console.log(`✅ Using moduleId: ${currentModuleId}`);
      await executeCommand(command);
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