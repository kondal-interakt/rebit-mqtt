// RVM Agent v2.5 FIXED - Belt Movement Correction
// Changes: 
// - Fixed cycle sequence: Use transferForward (type 02) to pull item from gate to pusher area (was reverse, causing ejection)
// - Later transfer: Use transferReverse (type 01) to clear/reset belt after push
// - Added gate open/close in motor tests for proper belt engagement
// - Increased run delays in tests for better observation (belt: 5s, pusher: 4s)
// - Pusher tests: Adjusted types based on doc (focus on 03 for forward; 01/02 as potential reverse/idle)
// - Ignore stepper recovery during tests to avoid interference
// Save as: agent-v2.5-FIXED.js
// Run: node agent-v2.5-FIXED.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

console.log('🔥 LOADING RVM AGENT VERSION 2.5 FIXED - BELT CORRECTION 🔥');

// ======= CONFIGURATION =======
const DEVICE_ID = 'RVM-3101';
const LOCAL_API_BASE = 'http://localhost:8081';
const WS_URL = 'ws://localhost:8081/websocket/qazwsx1234';

const MQTT_BROKER_URL = 'mqtts://mqtt.ceewen.xyz:8883';
const MQTT_USERNAME = 'mqttuser';
const MQTT_PASSWORD = 'mqttUser@2025';
const MQTT_CA_FILE = 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle';

// State
let currentModuleId = null;
let latestAIResult = null;
let latestWeight = null;
let pendingCommands = new Map();
let motorStatusCache = {};
let recoveryInProgress = false;
let autoCycleEnabled = false;
let cycleInProgress = false;
let calibrationAttempts = 0;

const IGNORE_MOTOR_RECOVERY = ['05'];  // Ignore stepper during normal op; tests handle separately
let ws = null;

// ======= WEBSOCKET =======
function connectWebSocket() {
  console.log(`🔌 Connecting to WebSocket...`);
  ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected');
    setTimeout(() => requestModuleId(), 1000);
  });
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      console.log(`📨 WS [${message.function}]:`, typeof message.data === 'string' && message.data.length > 100 ? message.data.substring(0, 100) + '...' : message.data);
      
      if (message.msg === '连接成功' || message.msg === 'connection successful') {
        console.log('✅ Connection confirmed');
        return;
      }
      
      if (message.function === '01') {
        currentModuleId = message.moduleId;
        console.log(`✅ Module ID: ${currentModuleId}`);
        
        if (pendingCommands.size > 0) {
          const [id, cmd] = Array.from(pendingCommands.entries())[0];
          executeCommand(cmd);
          pendingCommands.delete(id);
        }
        return;
      }
      
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        const probability = aiData.probability || 0;
        
        latestAIResult = {
          matchRate: Math.round(probability * 100),
          materialType: determineMaterialType(aiData),
          className: aiData.className || '',
          taskId: aiData.taskId,
          timestamp: new Date().toISOString()
        };
        
        console.log('🤖 AI Result:');
        console.log(`   Match: ${latestAIResult.matchRate}%`);
        console.log(`   Material: ${latestAIResult.materialType}`);
        
        mqttClient.publish(`rvm/${DEVICE_ID}/ai_result`, JSON.stringify(latestAIResult));
        
        if (autoCycleEnabled && latestAIResult.matchRate >= 30 && latestAIResult.materialType !== 'UNKNOWN') {
          console.log('🤖 AUTO: Getting weight...');
          setTimeout(() => executeCommand({ action: 'getWeight' }), 500);
        }
        return;
      }
      
      if (message.function === '06') {
        const weightValue = parseFloat(message.data) || 0;
        
        latestWeight = {
          weight: weightValue,
          timestamp: new Date().toISOString()
        };
        
        console.log(`⚖️ Weight: ${latestWeight.weight}g`);
        console.log(`   Raw data: ${message.data}`);
        
        mqttClient.publish(`rvm/${DEVICE_ID}/weight_result`, JSON.stringify(latestWeight));
        
        if (latestWeight.weight <= 0 && calibrationAttempts < 2) {
          calibrationAttempts++;
          console.log(`⚠️ AUTO: Calibrating (attempt ${calibrationAttempts}/2)...`);
          setTimeout(async () => {
            await executeCommand({ action: 'calibrateWeight' });
            setTimeout(() => executeCommand({ action: 'getWeight' }), 1000);
          }, 500);
          return;
        } else if (latestWeight.weight <= 0 && calibrationAttempts >= 2) {
          console.log('⚠️ Calibration failed after 2 attempts');
          calibrationAttempts = 0;
          return;
        }
        
        if (latestWeight.weight > 0) calibrationAttempts = 0;
        
        if (autoCycleEnabled && latestAIResult && latestWeight.weight > 10 && !cycleInProgress) {
          console.log('✅ AUTO: Starting cycle...');
          cycleInProgress = true;
          await executeFullCycle();
        } else if (latestWeight.weight <= 10 && latestWeight.weight > 0) {
          console.log(`⚠️ Weight too low (${latestWeight.weight}g)`);
          await executeCommand({ action: 'openGate' });
          setTimeout(() => executeCommand({ action: 'closeGate' }), 2000);
        }
        return;
      }
      
      if (message.function === '03') {
        try {
          const motors = JSON.parse(message.data);
          console.log('📊 Motor Status:', motors.length, 'motors');
          
          motors.forEach(motor => {
            motorStatusCache[motor.motorType] = motor;
          });
          
          const abnormals = motors.filter(m => m.state === 1);
          
          if (abnormals.length > 0 && !recoveryInProgress) {
            const recoverableMotors = abnormals.filter(m => !IGNORE_MOTOR_RECOVERY.includes(m.motorType));
            
            if (recoverableMotors.length > 0) {
              console.log('🚨 ABNORMAL:', recoverableMotors.map(m => m.motorTypeDesc));
              await autoRecoverMotors(recoverableMotors);
            }
            
            const ignoredMotors = abnormals.filter(m => IGNORE_MOTOR_RECOVERY.includes(m.motorType));
            if (ignoredMotors.length > 0) {
              console.log('⚠️ Known hardware issue (ignored):', ignoredMotors.map(m => m.motorTypeDesc));
            }
          } else if (abnormals.length === 0) {
            console.log('✅ All motors normal');
          }
        } catch (err) {
          console.error('❌ Parse motor status error:', err.message);
        }
        return;
      }
      
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        if (code === 4 && autoCycleEnabled && !cycleInProgress) {
          console.log('👤 AUTO: Object detected');
          setTimeout(() => executeCommand({ action: 'takePhoto' }), 1000);
        }
        return;
      }
      
      if (message.function === 'qrcode') {
        console.log('🔍 QR Code Scanned:', message.data);
        mqttClient.publish(`rvm/${DEVICE_ID}/qrcode`, JSON.stringify({
          data: message.data,
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      mqttClient.publish(`rvm/${DEVICE_ID}/events`, JSON.stringify({
        deviceId: DEVICE_ID,
        function: message.function,
        data: message.data,
        timestamp: new Date().toISOString()
      }));
      
    } catch (err) {
      console.error('❌ WS parse error:', err.message);
    }
  });
  
  ws.on('close', () => {
    console.log('⚠️ WS closed, reconnecting...');
    setTimeout(connectWebSocket, 5000);
  });
  
  ws.on('error', (err) => console.error('❌ WS error:', err.message));
}

// ======= AUTO-RECOVERY =======
async function autoRecoverMotors(abnormals) {
  if (recoveryInProgress) {
    console.log('⏳ Recovery already in progress, skipping...');
    return;
  }
  recoveryInProgress = true;
  
  console.log('🔧 AUTO-RECOVERY: Starting...');
  
  for (const motor of abnormals) {
    try {
      console.log(`🔧 Recovering ${motor.motorTypeDesc} (Motor ${motor.motorType})...`);
      
      switch (motor.motorType) {
        case '01': 
          await executeCommand({ action: 'closeGate' });
          await delay(1000);
          break;
        case '02': 
          await executeCommand({ action: 'transferStop' });
          await delay(500);
          break;
        case '03': 
          await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '00' } });
          await delay(500);
          break;
        case '04': 
          await executeCommand({ action: 'compactorStop' });
          await delay(500);
          break;
        case '05':
          console.log('🔧 Stepper motor abnormal - attempting extended reset...');
          await executeCommand({ action: 'stepperMotor', params: { position: '01' } });
          await delay(3000);
          await executeCommand({ action: 'stepperMotor', params: { position: '00' } });
          await delay(3000);
          console.log('✅ Stepper reset sequence complete');
          break;
      }
      
      console.log(`✅ Recovery attempt done: ${motor.motorTypeDesc}`);
    } catch (err) {
      console.error(`❌ Recovery failed: ${err.message}`);
    }
  }
  
  setTimeout(() => {
    recoveryInProgress = false;
    console.log('✅ Recovery cooldown complete');
  }, 30000);
  
  console.log('🔧 Recovery sequence finished (30s cooldown active)');
}

// ======= FULL CYCLE - FIXED BELT SEQUENCE =======
async function executeFullCycle() {
  console.log('🚀 AUTO: Full cycle starting (Belt fixed)');
  
  try {
    let stepperPos = '00';
    let collectMotor = '02';
    
    switch (latestAIResult.materialType) {
      case 'PLASTIC_BOTTLE': stepperPos = '03'; collectMotor = '03'; break;
      case 'METAL_CAN': stepperPos = '02'; collectMotor = '02'; break;
      case 'GLASS': stepperPos = '01'; collectMotor = '02'; break;
    }
    
    console.log(`📍 Routing to bin ${stepperPos} for ${latestAIResult.materialType}`);
    
    const sequence = [
      { action: 'stepperMotor', params: { position: stepperPos } },
      { delay: 2000 },
      { action: 'transferForward' },  // FIXED: Pull item from gate INTO machine to pusher (type 02: forward to limit)
      { delay: 8000 },
      { action: 'customMotor', params: { motorId: collectMotor, type: '03' } },  // Pusher to bin
      { delay: 3000 },
      { action: 'customMotor', params: { motorId: collectMotor, type: '00' } },  // Stop pusher
      { delay: 500 },
      { action: 'transferReverse' },  // FIXED: Reverse belt to clear/return to compactor area (type 01: reverse back)
      { delay: 2000 },
      { action: 'transferStop' },
      { delay: 500 },
      { action: 'compactorStart' },
      { delay: 5000 },
      { action: 'compactorStop' },
      { delay: 1000 },
      { action: 'stepperMotor', params: { position: '00' } },
      { delay: 1000 },
      { action: 'closeGate' }
    ];
    
    await executeSequence(sequence);
    
    console.log('🏁 Cycle completed!');
    
    mqttClient.publish(`rvm/${DEVICE_ID}/cycle_complete`, JSON.stringify({
      material: latestAIResult.materialType,
      weight: latestWeight.weight,
      binPosition: stepperPos,
      timestamp: new Date().toISOString()
    }));
    
    cycleInProgress = false;
    latestAIResult = null;
    latestWeight = null;
    
    console.log('✅ Ready for next item');
    
  } catch (err) {
    console.error('❌ Cycle failed:', err.message);
    cycleInProgress = false;
    await executeCommand({ action: 'compactorStop' });
    await executeCommand({ action: 'closeGate' });
  }
}

// ======= MOTOR DIRECTION TEST - ENHANCED =======
async function runMotorTests() {
  console.log('🧪 Starting automated motor direction tests (Gate auto-open)...');
  console.log('👁️ WATCH THE MACHINE CAREFULLY!\n');
  
  // Open gate for belt tests
  console.log('🚪 Opening gate for belt tests...');
  await executeCommand({ action: 'openGate' });
  await delay(2000);
  
  // TEST 1: Belt Type 01 (Doc: Reverse Back - expect OUT/eject)
  console.log('========================================');
  console.log('TEST 1: Belt Motor (02) - Type 01 (Reverse Back)');
  console.log('========================================');
  console.log('Place bottle at gate entrance (now open)...');
  console.log('Starting in 5 seconds...\n');
  await delay(5000);
  
  console.log('🔄 Running: Motor 02, Type 01 (5s)');
  await executeCommand({ action: 'customMotor', params: { motorId: '02', type: '01' } });
  await delay(5000);  // Increased for better movement
  console.log('🛑 Stopping motor');
  await executeCommand({ action: 'customMotor', params: { motorId: '02', type: '00' } });
  console.log('❓ Did bottle move INTO machine or OUT toward gate?');
  console.log('   Write this down: Belt Type 01 = IN or OUT\n');
  await delay(3000);
  
  // TEST 2: Belt Type 02 (Doc: Forward to Limit - expect IN/pull)
  console.log('========================================');
  console.log('TEST 2: Belt Motor (02) - Type 02 (Forward to Limit)');
  console.log('========================================');
  console.log('Place bottle at gate entrance again...');
  console.log('Starting in 5 seconds...\n');
  await delay(5000);
  
  console.log('🔄 Running: Motor 02, Type 02 (5s)');
  await executeCommand({ action: 'customMotor', params: { motorId: '02', type: '02' } });
  await delay(5000);  // Increased
  console.log('🛑 Stopping motor');
  await executeCommand({ action: 'customMotor', params: { motorId: '02', type: '00' } });
  console.log('❓ Did bottle move INTO machine or OUT toward gate?');
  console.log('   Write this down: Belt Type 02 = IN or OUT\n');
  await delay(3000);
  
  // Close gate for pusher tests (safety)
  console.log('🚪 Closing gate for pusher tests...');
  await executeCommand({ action: 'closeGate' });
  await delay(2000);
  
  // TEST 3: Pusher Type 01 (Potential reverse/idle per doc)
  console.log('========================================');
  console.log('TEST 3: Pusher Motor (03) - Type 01');
  console.log('========================================');
  console.log('Place bottle in middle of belt (near pusher - gate closed)...');
  console.log('Starting in 5 seconds...\n');
  await delay(5000);
  
  console.log('🔄 Running: Motor 03, Type 01 (4s)');
  await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '01' } });
  await delay(4000);  // Increased for pusher
  console.log('🛑 Stopping motor');
  await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '00' } });
  console.log('❓ Did pusher push INTO bin or OUT toward gate?');
  console.log('   Write this down: Pusher Type 01 = INTO_BIN or OUT_GATE\n');
  await delay(3000);
  
  // TEST 4: Pusher Type 02 (Potential forward/idle)
  console.log('========================================');
  console.log('TEST 4: Pusher Motor (03) - Type 02');
  console.log('========================================');
  console.log('Place bottle in middle of belt again...');
  console.log('Starting in 5 seconds...\n');
  await delay(5000);
  
  console.log('🔄 Running: Motor 03, Type 02 (4s)');
  await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '02' } });
  await delay(4000);
  console.log('🛑 Stopping motor');
  await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '00' } });
  console.log('❓ Did pusher push INTO bin or OUT toward gate?');
  console.log('   Write this down: Pusher Type 02 = INTO_BIN or OUT_GATE\n');
  await delay(3000);
  
  // TEST 5: Pusher Type 03 (Doc: Forward to Collect Bin)
  console.log('========================================');
  console.log('TEST 5: Pusher Motor (03) - Type 03 (CURRENT - Forward to Bin)');
  console.log('========================================');
  console.log('Place bottle in middle of belt again...');
  console.log('Starting in 5 seconds...\n');
  await delay(5000);
  
  console.log('🔄 Running: Motor 03, Type 03 (4s)');
  await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '03' } });
  await delay(4000);
  console.log('🛑 Stopping motor');
  await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '00' } });
  console.log('❓ Did pusher push INTO bin or OUT toward gate?');
  console.log('   Write this down: Pusher Type 03 = INTO_BIN or OUT_GATE\n');
  await delay(2000);
  
  // Final close gate
  await executeCommand({ action: 'closeGate' });
  
  // Summary
  console.log('\n========================================');
  console.log('✅ TESTS COMPLETED!');
  console.log('========================================');
  console.log('');
  console.log('📋 RESULTS TO RECORD:');
  console.log('');
  console.log('BELT MOTOR (02):');
  console.log('  Type 01 (Reverse): Bottle moved _____ (IN/OUT)');
  console.log('  Type 02 (Forward): Bottle moved _____ (IN/OUT)');
  console.log('');
  console.log('PUSHER MOTOR (03):');
  console.log('  Type 01: Pushed _____ (INTO_BIN/OUT_GATE)');
  console.log('  Type 02: Pushed _____ (INTO_BIN/OUT_GATE)');
  console.log('  Type 03 (Forward): Pushed _____ (INTO_BIN/OUT_GATE)');
  console.log('');
  console.log('========================================');
  console.log('🎯 If still issues, check hardware/wiring. Cycle now uses Forward first to prevent ejection!');
  console.log('========================================\n');
  
  mqttClient.publish(`rvm/${DEVICE_ID}/test_complete`, JSON.stringify({
    message: 'Motor tests completed (belt fixed)',
    timestamp: new Date().toISOString()
  }));
}

// ======= UTILITIES =======
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  
  if (className.includes('pet') || className.includes('plastic') || className.includes('瓶')) {
    return 'PLASTIC_BOTTLE';
  }
  if (className.includes('易拉罐') || className.includes('metal') || className.includes('can')) {
    return 'METAL_CAN';
  }
  if (className.includes('玻璃') || className.includes('glass')) {
    return 'GLASS';
  }
  
  return aiData.probability >= 0.5 ? 'PLASTIC_BOTTLE' : 'UNKNOWN';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======= EXECUTE COMMAND =======
async function executeCommand(commandData) {
  const { action, params } = commandData;
  const deviceType = 1;
  
  if (!currentModuleId && action !== 'getModuleId') {
    console.error('❌ No moduleId');
    return;
  }
  
  let apiUrl, apiPayload;
  
  if (action === 'openGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '01', type: '03', deviceType };
  } else if (action === 'closeGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '01', type: '00', deviceType };
  } else if (action === 'transferForward') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '02', type: '02', deviceType };  // Doc: Forward to limit (IN)
  } else if (action === 'transferReverse') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '02', type: '01', deviceType };  // Doc: Reverse back (OUT/clear)
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
    apiPayload = { moduleId: currentModuleId, type: '00' };
  } else if (action === 'calibrateWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/weightCalibration`;
    apiPayload = { moduleId: currentModuleId, type: '00' };
  } else if (action === 'takePhoto') {
    apiUrl = `${LOCAL_API_BASE}/system/camera/process`;
    apiPayload = {};
  } else if (action === 'stepperMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/stepMotorSelect`;
    apiPayload = { moduleId: currentModuleId, type: params?.position || '00', deviceType };
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
  
  console.log(`🔄 ${action}`);
  
  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log(`✅ ${action} executed`);
    
    if (action === 'takePhoto') {
      console.log('⏳ Waiting 2s for AI processing...');
      await delay(2000);
    } else if (action === 'getWeight') {
      console.log('⏳ Waiting 3s for weight reading...');
      await delay(3000);
    }
    
    mqttClient.publish(`rvm/${DEVICE_ID}/responses`, JSON.stringify({
      command: action,
      success: true,
      timestamp: new Date().toISOString()
    }));
    
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

async function executeSequence(sequence) {
  for (let step of sequence) {
    if (step.delay) {
      await delay(step.delay);
    } else if (step.action) {
      await executeCommand(step);
    }
  }
}

async function requestModuleId() {
  try {
    await axios.post(`${LOCAL_API_BASE}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('📥 Module ID requested');
  } catch (err) {
    console.error('❌ Module ID request failed:', err.message);
  }
}

// ======= MQTT =======
const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  ca: fs.readFileSync(MQTT_CA_FILE),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  console.log('✅ MQTT connected');
  
  mqttClient.subscribe(`rvm/${DEVICE_ID}/commands`);
  mqttClient.subscribe(`rvm/${DEVICE_ID}/control/auto`);
  
  connectWebSocket();
  
  setTimeout(requestModuleId, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    if (topic.includes('/control/auto')) {
      autoCycleEnabled = payload.enabled === true;
      console.log(`🤖 AUTO MODE: ${autoCycleEnabled ? 'ON' : 'OFF'}`);
      
      if (autoCycleEnabled && currentModuleId) {
        console.log('🚪 Opening gate...');
        await executeCommand({ action: 'openGate' });
      } else if (!autoCycleEnabled && currentModuleId) {
        console.log('🚪 Closing gate...');
        await executeCommand({ action: 'closeGate' });
      }
      
      mqttClient.publish(`rvm/${DEVICE_ID}/status`, JSON.stringify({
        autoMode: autoCycleEnabled,
        cycleInProgress,
        timestamp: new Date().toISOString()
      }));
      return;
    }
    
    if (topic.includes('/commands') && payload.action === 'test/motors') {
      console.log('\n========================================');
      console.log('🧪 MOTOR DIRECTION TEST MODE (Fixed)');
      console.log('========================================\n');
      await runMotorTests();
      return;
    }
    
    if (topic.includes('/commands')) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (!currentModuleId) {
        console.log('⚠️ Fetching moduleId first...');
        pendingCommands.set(Date.now().toString(), payload);
        await requestModuleId();
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
console.log('🚀 RVM AGENT v2.5 FIXED');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🧪 TEST MODE:');
console.log('   Run: curl -X POST http://localhost:3008/api/rvm/RVM-3101/test/motors');
console.log('========================================\n');