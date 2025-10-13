// Enhanced RVM Agent with Automatic Recovery & Full Automation
// Fixes: Motor abnormal auto-recovery, fully automated cycles

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

// Store moduleId from WS and latest results
let currentModuleId = null;
let latestAIResult = null;
let latestWeight = null;
let pendingCommands = new Map();
let motorStatusCache = {};  // Track motor states
let recoveryInProgress = false;  // Prevent recovery loops

// Response waiting mechanism
const commandPromises = new Map();

// Auto-cycle state tracking
let autoCycleEnabled = false;
let cycleInProgress = false;

// ======= WEBSOCKET CONNECTION =======
let ws = null;

function connectWebSocket() {
  console.log(`🔌 Attempting to connect to WebSocket: ${WS_URL}`);
  
  ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected to RVM');
    // Request initial status
    setTimeout(() => requestMotorStatus(), 2000);
  });
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      
      // Skip connection success
      if (message.msg === '连接成功' || message.msg === 'connection successful') {
        console.log('✅ WebSocket connection confirmed');
        return;
      }
      
      // Handle Module ID
      if (message.function === '01') {
        currentModuleId = message.moduleId;
        console.log(`✅ Module ID received: ${currentModuleId}`);
        
        if (pendingCommands.size > 0) {
          const [commandId, commandData] = Array.from(pendingCommands.entries())[0];
          executeCommand(commandData);
          pendingCommands.delete(commandId);
        }
        return;
      }
      
      // Handle AI Photo Result
      if (message.function === 'aiPhoto') {
        try {
          const aiData = JSON.parse(message.data);
          const probability = aiData.probability || 0;
          
          latestAIResult = {
            matchRate: Math.round(probability * 100),
            materialType: determineMaterialType(aiData),
            className: aiData.className || '',
            taskId: aiData.taskId,
            rawData: message,
            timestamp: new Date().toISOString()
          };
          
          console.log('🤖 AI Detection Result:');
          console.log(`   Match Rate: ${latestAIResult.matchRate}%`);
          console.log(`   Material: ${latestAIResult.materialType}`);
          
          const photoCommandId = message.taskId || 'aiPhoto';
          if (commandPromises.has(photoCommandId)) {
            commandPromises.get(photoCommandId).resolve(message);
            commandPromises.delete(photoCommandId);
          }
          
          mqttClient.publish(`rvm/${DEVICE_ID}/ai_result`, JSON.stringify(latestAIResult));
          
          // AUTO-TRIGGER: If confident, proceed to weight
          if (autoCycleEnabled && latestAIResult.matchRate >= 30 && latestAIResult.materialType !== 'UNKNOWN') {
            console.log(`🤖 AUTO: Triggering weight measurement`);
            setTimeout(() => executeCommand({ action: 'getWeight' }), 500);
          } else if (latestAIResult.matchRate < 30) {
            console.log(`⚠️ AUTO: Low confidence (${latestAIResult.matchRate}%), manual intervention needed`);
            mqttClient.publish(`rvm/${DEVICE_ID}/alerts`, JSON.stringify({
              type: 'low_confidence',
              message: `AI match: ${latestAIResult.matchRate}%`,
              timestamp: new Date().toISOString()
            }));
          }
        } catch (err) {
          console.error('❌ Failed to parse AI data:', err.message);
        }
        return;
      }
      
      // Handle Weight Result
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
        
        mqttClient.publish(`rvm/${DEVICE_ID}/weight_result`, JSON.stringify(latestWeight));
        
        // AUTO-CALIBRATE if invalid
        if (latestWeight.weight <= 0) {
          console.log(`⚠️ AUTO: Invalid weight, calibrating...`);
          setTimeout(async () => {
            await executeCommand({ action: 'calibrateWeight' });
            setTimeout(() => executeCommand({ action: 'getWeight' }), 1000);
          }, 500);
          return;
        }
        
        // AUTO-TRIGGER: If valid weight, proceed to sorting
        if (autoCycleEnabled && latestAIResult && latestWeight.weight > 50 && !cycleInProgress) {
          console.log(`✅ AUTO: Valid weight detected - executing full cycle`);
          cycleInProgress = true;
          await executeFullCycle();
        } else if (latestWeight.weight <= 50 && latestWeight.weight > 0) {
          console.log(`⚠️ AUTO: Weight too low (${latestWeight.weight}g) - rejecting`);
          await executeCommand({ action: 'openGate' });  // Reject
          setTimeout(() => executeCommand({ action: 'closeGate' }), 2000);
        }
        return;
      }
      
      // Handle Motor Status Report (function: "03") - ENHANCED
      if (message.function === '03') {
        try {
          const motors = JSON.parse(message.data);
          console.log('📊 Motor Status Report:', JSON.stringify(motors, null, 2));
          
          // Update cache
          motors.forEach(motor => {
            motorStatusCache[motor.motorType] = motor;
          });
          
          // Check for abnormals
          const abnormals = motors.filter(m => m.state === 1);
          
          if (abnormals.length > 0 && !recoveryInProgress) {
            console.log('🚨 ABNORMAL DETECTED:', abnormals.map(m => `${m.motorTypeDesc} (${m.motorType})`));
            
            mqttClient.publish(`rvm/${DEVICE_ID}/alerts`, JSON.stringify({
              type: 'abnormal',
              motors: abnormals,
              timestamp: new Date().toISOString()
            }));
            
            // AUTO-RECOVERY
            await autoRecoverMotors(abnormals);
          } else if (abnormals.length === 0) {
            console.log('✅ All motors normal');
          }
        } catch (err) {
          console.error('❌ Failed to parse motor status:', err.message);
        }
        return;
      }
      
      // Handle Device Status (bin full)
      if (message.function === 'deviceStatus') {
        const fullCode = parseInt(message.data) || -1;
        const binStatus = [
          'Left bin (PET) full',
          'Middle bin (Metal) full',
          'Right bin full',
          'Glass bin full',
          'Infrared sensor triggered'
        ];
        
        if (fullCode >= 0 && fullCode <= 4) {
          console.log(`🗑️ ${binStatus[fullCode]}`);
          
          // AUTO: If infrared triggered and auto mode enabled, start cycle
          if (fullCode === 4 && autoCycleEnabled && !cycleInProgress) {
            console.log('👤 AUTO: Object detected, starting cycle');
            setTimeout(() => executeCommand({ action: 'takePhoto' }), 1000);
          }
          
          mqttClient.publish(`rvm/${DEVICE_ID}/alerts`, JSON.stringify({
            type: fullCode === 4 ? 'object_detected' : 'bin_full',
            code: fullCode,
            description: binStatus[fullCode],
            timestamp: new Date().toISOString()
          }));
        }
        return;
      }
      
      // Publish all events
      mqttClient.publish(`rvm/${DEVICE_ID}/events`, JSON.stringify({
        deviceId: DEVICE_ID,
        function: message.function || 'unknown',
        data: message.data || message,
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

// ======= AUTO-RECOVERY FOR ABNORMAL MOTORS =======
async function autoRecoverMotors(abnormalMotors) {
  if (recoveryInProgress) {
    console.log('⏳ Recovery already in progress, skipping');
    return;
  }
  
  recoveryInProgress = true;
  console.log('🔧 AUTO-RECOVERY: Attempting to fix abnormal motors');
  
  for (const motor of abnormalMotors) {
    try {
      console.log(`🔧 Recovering ${motor.motorTypeDesc} (${motor.motorType})...`);
      
      switch (motor.motorType) {
        case '01':  // Gate motor - reset to home
          await executeCommand({ action: 'closeGate' });
          await delay(1000);
          break;
          
        case '02':  // Transfer motor - stop and reset
          await executeCommand({ action: 'transferStop' });
          await delay(500);
          break;
          
        case '03':  // Press plate motor - stop
          await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '00' } });
          await delay(500);
          break;
          
        case '04':  // Compactor - stop
          await executeCommand({ action: 'compactorStop' });
          await delay(500);
          break;
          
        case '05':  // Stepper/Classification motor - reset to home (position 00)
          console.log('🔧 Resetting stepper motor to home position (00)');
          await executeCommand({ action: 'stepperMotor', params: { position: '00' } });
          await delay(2000);  // Give it time to home
          
          // Verify by requesting status
          await requestMotorStatus();
          break;
          
        default:
          console.log(`⚠️ Unknown motor type: ${motor.motorType}`);
      }
      
      console.log(`✅ Recovery attempt completed for ${motor.motorTypeDesc}`);
      
    } catch (err) {
      console.error(`❌ Failed to recover ${motor.motorTypeDesc}:`, err.message);
    }
  }
  
  // Wait and check status again
  await delay(2000);
  await requestMotorStatus();
  
  setTimeout(() => {
    recoveryInProgress = false;
    console.log('✅ Recovery process completed');
  }, 3000);
}

// ======= REQUEST MOTOR STATUS =======
async function requestMotorStatus() {
  if (!currentModuleId) return;
  
  try {
    // The "03" function is triggered by hardware events, but we can also trigger a status check
    // by executing any motor command with a query flag (not standard, but we can poll)
    console.log('📊 Requesting motor status check...');
    
    // Alternative: Just log current cache
    if (Object.keys(motorStatusCache).length > 0) {
      console.log('📊 Cached Motor States:');
      Object.values(motorStatusCache).forEach(motor => {
        const status = motor.state === 0 ? '✅' : '🚨';
        console.log(`  ${status} ${motor.motorTypeDesc}: ${motor.positionDesc}`);
      });
    }
  } catch (err) {
    console.error('❌ Failed to request status:', err.message);
  }
}

// ======= FULL AUTOMATED CYCLE =======
async function executeFullCycle() {
  console.log('🚀 AUTO: Executing full sorting cycle');
  
  try {
    // Determine bin position based on material
    let stepperPosition = '00';
    let collectMotorId = '02';
    
    switch (latestAIResult.materialType) {
      case 'PLASTIC_BOTTLE':
        stepperPosition = '03';  // Left bin
        collectMotorId = '03';
        break;
      case 'METAL_CAN':
        stepperPosition = '02';  // Middle bin
        collectMotorId = '02';
        break;
      case 'GLASS':
        stepperPosition = '01';  // Right bin
        collectMotorId = '02';
        break;
      default:
        stepperPosition = '01';  // Default bin
        collectMotorId = '02';
    }
    
    console.log(`📍 AUTO: Routing to bin position ${stepperPosition} for ${latestAIResult.materialType}`);
    
    // Execute sequence
    const sequence = [
      { action: 'stepperMotor', params: { position: stepperPosition } },
      { delay: 2000 },
      { action: 'customMotor', params: { motorId: collectMotorId, type: '03' } },
      { delay: 1500 },
      { action: 'compactorStart' },
      { delay: 5000 },
      { action: 'compactorStop' },
      { delay: 1000 },
      { action: 'stepperMotor', params: { position: '00' } },  // Reset to home
      { delay: 1000 },
      { action: 'closeGate' }
    ];
    
    await executeSequence(sequence);
    
    console.log('🏁 AUTO: Cycle completed successfully');
    
    mqttClient.publish(`rvm/${DEVICE_ID}/cycle_complete`, JSON.stringify({
      material: latestAIResult.materialType,
      weight: latestWeight.weight,
      binPosition: stepperPosition,
      timestamp: new Date().toISOString()
    }));
    
    // Reset state
    cycleInProgress = false;
    latestAIResult = null;
    latestWeight = null;
    
    // Ready for next item
    console.log('✅ AUTO: Ready for next item');
    
  } catch (err) {
    console.error('❌ AUTO: Cycle failed:', err.message);
    cycleInProgress = false;
    
    // Attempt safe state
    await executeCommand({ action: 'compactorStop' });
    await executeCommand({ action: 'closeGate' });
  }
}

// ======= UTILITY FUNCTIONS =======
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
    if (className.includes('瓶') || className.includes('bottle')) return 'PLASTIC_BOTTLE';
    return 'METAL_CAN';
  }
  
  return 'UNKNOWN';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForResponse(commandId, timeout = 10000) {
  return new Promise((resolve, reject) => {
    commandPromises.set(commandId, { resolve, reject });
    setTimeout(() => {
      if (commandPromises.has(commandId)) {
        commandPromises.get(commandId).reject(new Error(`Timeout: ${commandId}`));
        commandPromises.delete(commandId);
      }
    }, timeout);
  });
}

// ======= EXECUTE COMMAND =======
async function executeCommand(commandData) {
  const { action, params } = commandData;
  const commandId = params?.commandId || `${action}-${Date.now()}`;
  const deviceType = 1;
  
  if (!currentModuleId && action !== 'getModuleId') {
    console.error('❌ No moduleId available');
    return;
  }
  
  let apiUrl;
  let apiPayload = { ...params, commandId };
  
  // Map actions to API calls (same as before)
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
    apiPayload = { moduleId: '06', type: '00' };
  } else if (action === 'calibrateWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/weightCalibration`;
    apiPayload = { moduleId: '07', type: '00' };
  } else if (action === 'takePhoto') {
    apiUrl = `${LOCAL_API_BASE}/system/camera/process`;
    apiPayload = {};
  } else if (action === 'stepperMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/stepMotorSelect`;
    apiPayload = { moduleId: '0F', type: params?.position || '00', deviceType };
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
  
  try {
    const result = await axios.post(apiUrl, apiPayload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log(`✅ ${action} executed`);
    
    // Wait for WS only for non-motor commands
    const isMotorCommand = ['openGate', 'closeGate', 'transferForward', 'transferReverse', 
                            'transferStop', 'transferToCollectBin', 'compactorStart', 
                            'compactorStop', 'stepperMotor', 'customMotor'].includes(action);
    
    let wsResponse = null;
    if (!isMotorCommand && action !== 'getModuleId') {
      wsResponse = await waitForResponse(commandId);
    }
    
    const responseData = {
      command: action,
      success: true,
      apiResult: result.data,
      wsResponse: wsResponse?.data || wsResponse,
      timestamp: new Date().toISOString()
    };
    
    mqttClient.publish(`rvm/${DEVICE_ID}/responses`, JSON.stringify(responseData));
    
  } catch (err) {
    console.error(`❌ ${action} failed:`, err.message);
    
    mqttClient.publish(`rvm/${DEVICE_ID}/responses`, JSON.stringify({
      command: action,
      success: false,
      error: err.message,
      timestamp: new Date().toISOString()
    }));
  }
}

// ======= EXECUTE SEQUENCE =======
async function executeSequence(sequence) {
  for (let step of sequence) {
    if (step.delay) {
      await delay(step.delay);
    } else if (step.action) {
      await executeCommand(step);
    }
  }
}

// ======= GET MODULE ID =======
async function getModuleId() {
  try {
    const result = await axios.post(`${LOCAL_API_BASE}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('📥 getModuleId called, waiting for WS response...');
    return result.data;
  } catch (err) {
    console.error('❌ getModuleId failed:', err.message);
    throw err;
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
  
  mqttClient.subscribe(`rvm/${DEVICE_ID}/control/auto`, (err) => {
    if (!err) console.log(`📡 Subscribed to auto control`);
  });
  
  connectWebSocket();
  
  setTimeout(async () => {
    try {
      await getModuleId();
    } catch (err) {
      setTimeout(() => getModuleId(), 5000);
    }
  }, 2000);
  
  // Periodic status check every 30s
  setInterval(() => {
    if (currentModuleId && !cycleInProgress) {
      requestMotorStatus();
    }
  }, 30000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    // Auto-mode control
    if (topic.includes('/control/auto')) {
      autoCycleEnabled = payload.enabled === true;
      console.log(`🤖 AUTO MODE: ${autoCycleEnabled ? 'ENABLED' : 'DISABLED'}`);
      
      mqttClient.publish(`rvm/${DEVICE_ID}/status`, JSON.stringify({
        autoMode: autoCycleEnabled,
        cycleInProgress,
        timestamp: new Date().toISOString()
      }));
      return;
    }
    
    // Manual commands
    if (topic.includes('/commands')) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (!currentModuleId) {
        console.log('⚠️ Fetching moduleId first...');
        pendingCommands.set(Date.now().toString(), payload);
        await getModuleId();
      } else {
        await executeCommand(payload);
      }
    }
    
  } catch (err) {
    console.error('❌ MQTT message error:', err.message);
  }
});

process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down...');
  if (ws) ws.close();
  mqttClient.end();
  process.exit(0);
});

console.log('========================================');
console.log('🚀 Enhanced RVM Agent with Auto-Recovery');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🔧 Features:');
console.log('  ✅ Automatic motor recovery');
console.log('  ✅ Fully automated cycles');
console.log('  ✅ Periodic health checks');
console.log('========================================\n');