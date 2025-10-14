// RVM Agent v2.6 IMPROVED - Enhanced Grip & Travel
// Changes: 
// - Belt forward: 8s delay + repeat if stuck (check WS status).
// - Tests: Upright placement prompts, pre-advance for pusher.
// - Temp ignore all recovery during tests.
// - Auto-calibrate after tests.
// Save as: agent-v2.6-IMPROVED.js
// Run: node agent-v2.6-IMPROVED.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

console.log('🔥 LOADING RVM AGENT VERSION 2.6 IMPROVED - GRIP FIX 🔥');

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
let testMode = false;  // NEW: Flag to pause recovery during tests

const IGNORE_MOTOR_RECOVERY = ['05'];  // Base ignore for stepper
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
          
          if (abnormals.length > 0 && !recoveryInProgress && !testMode) {  // NEW: Skip recovery if testMode active
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
      { action: 'transferForward' },  // Pull item from gate INTO machine to pusher (type 02: forward to limit)
      { delay: 8000 },
      { action: 'customMotor', params: { motorId: collectMotor, type: '03' } },  // Pusher to bin
      { delay: 3000 },
      { action: 'customMotor', params: { motorId: collectMotor, type: '00' } },  // Stop pusher
      { delay: 500 },
      { action: 'transferReverse' },  // Reverse belt to clear/return to compactor area (type 01: reverse back)
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

// ======= MOTOR DIRECTION TEST - GRIP-ENHANCED =======
async function runMotorTests() {
  testMode = true;  // Pause recovery during tests
  console.log('🧪 Starting improved motor tests (upright placement required)...');
  console.log('👁️ TIP: Place bottle UPRIGHT & CENTERED on yellow belt for grip!\n');
  
  // Global gate open
  console.log('🚪 Opening gate...');
  await executeCommand({ action: 'openGate' });
  await delay(2000);
  
  // TEST 1: Belt Reverse (Type 01 - Expect OUT)
  console.log('========================================');
  console.log('TEST 1: Belt (02) Type 01 - Reverse (Expect eject)');
  console.log('========================================');
  console.log('🍼 Place UPRIGHT bottle at gate/belt start... 5s countdown.\n');
  await delay(5000);
  
  await executeCustomMotorWithRepeat('02', '01', 8000);  // Reverse 8s
  await executeCommand({ action: 'transferStop' });
  console.log('❓ Bottle ejected OUT? (Yes = good)\n');
  await delay(3000);
  
  // TEST 2: Belt Forward (Type 02 - Expect IN/pull to pusher)
  console.log('========================================');
  console.log('TEST 2: Belt (02) Type 02 - Forward to Limit (Expect pull IN)');
  console.log('========================================');
  console.log('🍼 Reposition UPRIGHT bottle at gate... 5s.\n');
  await delay(5000);
  
  await executeCustomMotorWithRepeat('02', '02', 8000);  // Forward 8s + repeat if stuck
  await executeCommand({ action: 'transferStop' });
  console.log('❓ Bottle pulled IN ~1m to pusher area? (If stuck, check tension)\n');
  await delay(3000);
  
  // Close gate for pusher safety
  await executeCommand({ action: 'closeGate' });
  await delay(2000);
  
  // TEST 3-5: Pusher (Pre-advance belt to position bottle)
  for (let typeNum = 1; typeNum <= 3; typeNum++) {
    console.log('========================================');
    console.log(`TEST ${typeNum + 2}: Pusher (03) Type ${typeNum} (Pre-advance belt)`);
    console.log('========================================');
    console.log('🍼 Place UPRIGHT bottle mid-belt... 5s.\n');
    await delay(5000);
    
    // Pre-advance belt to pusher position
    console.log('🔄 Pre-advancing belt...');
    await executeCustomMotorWithRepeat('02', '02', 4000);  // Short forward
    await delay(2000);
    
    await executeCustomMotorWithRepeat('03', typeNum.toString(), 5000);  // Pusher 5s
    await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '00' } });
    console.log(`❓ Pusher Type ${typeNum} pushed INTO bin or OUT? (Type 03 = INTO expected)\n`);
    await delay(3000);
    
    // Reset belt after each
    await executeCommand({ action: 'transferReverse' });
    await delay(3000);
    await executeCommand({ action: 'transferStop' });
  }
  
  // Final reset & calibrate
  await executeCommand({ action: 'closeGate' });
  await executeCommand({ action: 'calibrateWeight' });
  await delay(2000);
  
  testMode = false;
  
  // Summary
  console.log('\n========================================');
  console.log('✅ TESTS DONE! Calibrated sensors.');
  console.log('📋 If still no grip: Tighten belt, clean surface, or upright only.');
  console.log('========================================\n');
  
  mqttClient.publish(`rvm/${DEVICE_ID}/test_complete`, JSON.stringify({
    message: 'Improved tests complete (grip enhanced)',
    timestamp: new Date().toISOString()
  }));
}

// NEW: Helper for motor run + repeat if stuck (check status)
async function executeCustomMotorWithRepeat(motorId, type, baseDelay) {
  await executeCommand({ action: 'customMotor', params: { motorId, type } });
  await delay(baseDelay);
  
  // Check if still "moving" in cache (simple stuck detect)
  setTimeout(async () => {
    if (motorStatusCache[motorId] && motorStatusCache[motorId].state === 0) {  // Normal? No repeat
      console.log('✅ Full movement detected');
    } else {
      console.log('⚠️ Possible stuck - repeating 3s...');
      await executeCommand({ action: 'customMotor', params: { motorId, type } });
      await delay(3000);
    }
  }, baseDelay / 2);
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
      testMode = true;  // Set flag
      await runMotorTests();
      testMode = false;
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
console.log('🚀 RVM AGENT v2.6 IMPROVED');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🧪 TEST MODE: Upright bottle for grip!');
console.log('   Run: curl -X POST http://localhost:3008/api/rvm/RVM-3101/test/motors');
console.log('========================================\n');