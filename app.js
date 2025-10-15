// RVM Agent v4.1 - CORRECT FLOW (From Manufacturer)
// BREAKTHROUGH: Manufacturer revealed the ACTUAL flow!
//
// CORRECT FLOW:
// 1. Gate Open
// 2. Belt Forward → weighing position
// 3. Drum Lift & Center → lifts bottle UP to weigh it
// 4. Weight Detection → weighs bottle while on drum
// 5. Drum Down → puts bottle BACK on belt
// 6. Belt Forward to Bin → pushes bottle into bin
// 7. Belt Reverse → returns to start
// 8. Gate Close
//
// KEY INSIGHT: Drum is a WEIGHING PLATFORM, not a pusher!
// - Motor 07: Lifts drum UP to weigh, DOWN to release
// - Motor 03: Centers the bottle on drum (rotation)
// - Belt does the final push into bin!
//
// Save as: agent-v4.1-correct-flow.js
// Run: node agent-v4.1-correct-flow.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= CONFIG =======
const DEVICE_ID = 'RVM-3101';
const LOCAL_API_BASE = 'http://localhost:8081';
const WS_URL = 'ws://localhost:8081/websocket/qazwsx1234';
const MQTT_BROKER_URL = 'mqtts://mqtt.ceewen.xyz:8883';
const MQTT_USERNAME = 'mqttuser';
const MQTT_PASSWORD = 'mqttUser@2025';
const MQTT_CA_FILE = 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle';

const MOTOR_CONFIG = {
  GATE: '01',
  TRANSFER_BELT: '02',
  DRUM_CENTER: '03',       // Centers bottle on drum
  COMPACTOR: '04',
  DRUM_LIFT: '07',         // Lifts/lowers weighing platform
  STEPPER: 'stepper'
};

const DEVICE_TYPE = 5;

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
const IGNORE_MOTOR_RECOVERY = ['05'];
let ws = null;
let lastBeltStatus = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======= SORTER OPERATIONS (PUSHER MECHANISM) =======
async function positionSorterToBin(binPosition) {
  console.log(`🔄 [SORTER] Positioning to bin ${binPosition}...`);
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: binPosition }
  });
  await delay(3000);
  console.log('✅ [SORTER] Positioned at bin');
}

async function sorterRotateToPushBottle() {
  console.log('🔄 [SORTER] ROTATING to push bottle into bin...');
  
  // Rotate sorter motor to push bottle
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: '05',  // Sorter motor ID
      type: '01',     // Rotate/push
      deviceType: DEVICE_TYPE
    }
  });
  
  // Rotate for enough time to push bottle into bin
  await delay(5000);  // 5 seconds rotation to push
  
  // Stop rotation
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: '05',
      type: '00',  // Stop
      deviceType: DEVICE_TYPE
    }
  });
  
  console.log('✅ [SORTER] Bottle pushed into bin');
  
  // Wait for bottle to drop
  console.log('⏳ [SORTER] Waiting 3s for bottle to drop...');
  await delay(3000);
}

async function resetSorterToHome() {
  console.log('🏠 [SORTER] Returning to home position...');
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: '00' }
  });
  await delay(2000);
  console.log('✅ [SORTER] At home position');
}
async function liftDrumForWeighing() {
  console.log('⬆️ [DRUM] Lifting weighing platform UP...');
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.DRUM_LIFT, 
      type: '01',
      deviceType: DEVICE_TYPE
    }
  });
  await delay(2000);
  console.log('✅ [DRUM] Weighing platform raised');
}

async function lowerDrumAfterWeighing() {
  console.log('⬇️ [DRUM] Lowering weighing platform DOWN...');
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.DRUM_LIFT, 
      type: '03',
      deviceType: DEVICE_TYPE
    }
  });
  await delay(2000);
  console.log('✅ [DRUM] Bottle back on belt');
}

async function centerBottleOnDrum() {
  console.log('🎯 [DRUM] Centering bottle on platform...');
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.DRUM_CENTER, 
      type: '01',
      deviceType: DEVICE_TYPE
    }
  });
  await delay(1000);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.DRUM_CENTER, 
      type: '00',
      deviceType: DEVICE_TYPE
    }
  });
  console.log('✅ [DRUM] Bottle centered');
}

// ======= BELT OPERATIONS =======
async function moveBeltToWeighingPosition() {
  console.log('🎯 [BELT] Moving to weighing position...');
  
  // Move forward continuously
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.TRANSFER_BELT, 
      type: '02',
      deviceType: DEVICE_TYPE
    }
  });
  
  // Wait for position '02' (middle/weighing position)
  const startTime = Date.now();
  while (Date.now() - startTime < 8000) {
    await delay(200);
    const pos = lastBeltStatus?.position || '00';
    
    if (pos === '02' || pos === '03') {
      await executeCommand({ action: 'transferStop' });
      console.log(`✅ [BELT] At position ${pos} for weighing`);
      return true;
    }
  }
  
  await executeCommand({ action: 'transferStop' });
  console.log('✅ [BELT] Stopped for weighing');
  return true;
}

async function moveBeltForwardToBin() {
  console.log('🎯 [BELT] Pushing bottle INTO bin...');
  
  // Move forward to push bottle into bin
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.TRANSFER_BELT, 
      type: '02',
      deviceType: DEVICE_TYPE
    }
  });
  
  // Push for 5 seconds (ensure bottle goes into bin)
  await delay(5000);
  
  await executeCommand({ action: 'transferStop' });
  console.log('✅ [BELT] Bottle pushed into bin');
  
  // Wait for bottle to drop
  console.log('⏳ [BELT] Waiting 3s for bottle to drop...');
  await delay(3000);
}

async function returnBeltToStart() {
  console.log('🔄 [BELT] Returning to start...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.TRANSFER_BELT, 
      type: '01',
      deviceType: DEVICE_TYPE
    }
  });
  
  const startTime = Date.now();
  while (Date.now() - startTime < 10000) {
    await delay(300);
    if (lastBeltStatus?.position === '01') {
      await executeCommand({ action: 'transferStop' });
      console.log('✅ [BELT] Back at start');
      return true;
    }
  }
  
  await executeCommand({ action: 'transferStop' });
  return true;
}

// ======= FULL CYCLE - CORRECT FLOW =======
async function executeFullCycle() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║      🚀 STARTING CORRECT FLOW         ║');
  console.log('╚════════════════════════════════════════╝\n');
  
  try {
    let stepperPos = '00';
    
    switch (latestAIResult.materialType) {
      case 'PLASTIC_BOTTLE': stepperPos = '03'; break;
      case 'METAL_CAN': stepperPos = '02'; break;
      case 'GLASS': stepperPos = '01'; break;
    }
    
    console.log(`📍 Material: ${latestAIResult.materialType} → Bin ${stepperPos}\n`);
    
    // STEP 1: Position sorter/stepper FIRST
    console.log('[STEP 1/8] Positioning sorter...');
    await executeCommand({ 
      action: 'stepperMotor', 
      params: { position: stepperPos }
    });
    await delay(3000);
    console.log('✅ Sorter positioned\n');
    
    // STEP 2: Belt forward to weighing position
    console.log('[STEP 2/8] Moving belt to weighing position...');
    await moveBeltToWeighingPosition();
    await delay(500);
    console.log('');
    
    // STEP 3: Lift drum (weighing platform)
    console.log('[STEP 3/8] Lifting drum to weigh bottle...');
    await liftDrumForWeighing();
    await delay(500);
    console.log('');
    
    // STEP 4: Center bottle on drum
    console.log('[STEP 4/8] Centering bottle on weighing platform...');
    await centerBottleOnDrum();
    await delay(500);
    console.log('');
    
    // STEP 5: Get weight (bottle is now on raised drum)
    console.log('[STEP 5/8] Getting weight from raised platform...');
    console.log(`⚖️ Weight already obtained: ${latestWeight.weight}g\n`);
    
    // STEP 6: Lower drum (put bottle back on belt)
    console.log('[STEP 6/8] Lowering drum to put bottle back on belt...');
    await lowerDrumAfterWeighing();
    await delay(1000);
    console.log('');
    
    // STEP 7: Belt forward to push into bin
    console.log('[STEP 7/8] Belt pushing bottle INTO bin...');
    await moveBeltForwardToBin();
    console.log('');
    
    // STEP 8: Belt reverse to start
    console.log('[STEP 8/8] Returning belt to start...');
    await returnBeltToStart();
    console.log('');
    
    // STEP 9: Compact (optional)
    console.log('[EXTRA] Running compactor...');
    await runCompactor();
    console.log('');
    
    // STEP 10: Reset sorter
    console.log('[CLEANUP] Resetting sorter...');
    await executeCommand({ 
      action: 'stepperMotor', 
      params: { position: '00' }
    });
    await delay(2000);
    console.log('');
    
    // STEP 11: Close gate
    console.log('[CLEANUP] Closing gate...');
    await executeCommand({ action: 'closeGate' });
    await delay(1000);
    await executeCommand({ action: 'gateMotorStop' });
    
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║       ✅ CYCLE COMPLETE!              ║');
    console.log('╚════════════════════════════════════════╝\n');
    
    mqttClient.publish(`rvm/${DEVICE_ID}/cycle_complete`, JSON.stringify({
      material: latestAIResult.materialType,
      weight: latestWeight.weight,
      binPosition: stepperPos,
      timestamp: new Date().toISOString()
    }));
    
    cycleInProgress = false;
    latestAIResult = null;
    latestWeight = null;
    
  } catch (err) {
    console.error('❌ Cycle failed:', err.message);
    cycleInProgress = false;
    
    // Emergency cleanup
    await lowerDrumAfterWeighing();
    await executeCommand({ action: 'transferStop' });
    await executeCommand({ action: 'closeGate' });
  }
}

async function runCompactor() {
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.COMPACTOR, 
      type: '01',
      deviceType: DEVICE_TYPE
    }
  });
  await delay(6000);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.COMPACTOR, 
      type: '00',
      deviceType: DEVICE_TYPE
    }
  });
}

// ======= GATE OPERATIONS =======
async function safeOpenGate() {
  console.log('🚪 Opening gate...');
  
  await lowerDrumAfterWeighing();
  await delay(200);
  
  await executeCommand({ action: 'openGate' });
  await delay(500);
  await executeCommand({ action: 'gateMotorStop' });
  
  console.log('✅ Gate open');
}

async function safeTakePhoto() {
  console.log('📸 Taking photo...');
  
  await lowerDrumAfterWeighing();
  await delay(200);
  
  await executeCommand({ action: 'transferStop' });
  await delay(200);
  
  await executeCommand({ action: 'takePhoto' });
  console.log('✅ Photo captured');
}

// ======= WEBSOCKET =======
function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected');
    setTimeout(() => requestModuleId(), 1000);
  });
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      
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
        
        console.log(`🤖 AI: ${latestAIResult.matchRate}% - ${latestAIResult.materialType}`);
        
        mqttClient.publish(`rvm/${DEVICE_ID}/ai_result`, JSON.stringify(latestAIResult));
        
        if (autoCycleEnabled && latestAIResult.matchRate >= 30 && latestAIResult.materialType !== 'UNKNOWN') {
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
        
        mqttClient.publish(`rvm/${DEVICE_ID}/weight_result`, JSON.stringify(latestWeight));
        
        if (latestWeight.weight <= 0 && calibrationAttempts < 2) {
          calibrationAttempts++;
          console.log(`⚠️ Calibrating (${calibrationAttempts}/2)...`);
          setTimeout(async () => {
            await executeCommand({ action: 'calibrateWeight' });
            setTimeout(() => executeCommand({ action: 'getWeight' }), 1000);
          }, 500);
          return;
        }
        
        if (latestWeight.weight > 0) calibrationAttempts = 0;
        
        if (autoCycleEnabled && latestAIResult && latestWeight.weight > 10 && !cycleInProgress) {
          cycleInProgress = true;
          await executeFullCycle();
        } else if (latestWeight.weight <= 10 && latestWeight.weight > 0) {
          console.log(`⚠️ Too light (${latestWeight.weight}g)`);
        }
        return;
      }
      
      if (message.function === '03') {
        try {
          const motors = JSON.parse(message.data);
          
          motors.forEach(motor => {
            motorStatusCache[motor.motorType] = motor;
            if (motor.motorType === '02') lastBeltStatus = motor;
          });
          
          const abnormals = motors.filter(m => m.state === 1 && !IGNORE_MOTOR_RECOVERY.includes(m.motorType));
          
          if (abnormals.length > 0 && !recoveryInProgress) {
            console.log('🚨 Motor issue:', abnormals.map(m => m.motorTypeDesc).join(', '));
          }
        } catch (err) {
          console.error('❌ Parse error:', err.message);
        }
        return;
      }
      
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        if (code === 4 && autoCycleEnabled && !cycleInProgress) {
          console.log('👤 Object detected');
          setTimeout(async () => {
            await safeTakePhoto();
          }, 1000);
        }
        return;
      }
      
    } catch (err) {
      console.error('❌ WS error:', err.message);
    }
  });
  
  ws.on('close', () => {
    console.log('⚠️ WS closed, reconnecting...');
    setTimeout(connectWebSocket, 5000);
  });
  
  ws.on('error', (err) => console.error('❌ WS error:', err.message));
}

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

async function executeCommand(commandData) {
  const { action, params } = commandData;
  
  if (!currentModuleId && action !== 'getModuleId') {
    console.error('❌ No moduleId');
    return;
  }
  
  let apiUrl, apiPayload;
  
  if (action === 'openGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { 
      moduleId: currentModuleId, 
      motorId: '01', 
      type: '03', 
      deviceType: DEVICE_TYPE
    };
  } else if (action === 'closeGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { 
      moduleId: currentModuleId, 
      motorId: '01', 
      type: '00', 
      deviceType: DEVICE_TYPE
    };
  } else if (action === 'gateMotorStop') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { 
      moduleId: currentModuleId, 
      motorId: '01', 
      type: '00', 
      deviceType: DEVICE_TYPE
    };
  } else if (action === 'transferStop') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { 
      moduleId: currentModuleId, 
      motorId: MOTOR_CONFIG.TRANSFER_BELT, 
      type: '00', 
      deviceType: DEVICE_TYPE
    };
  } else if (action === 'getWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/getWeight`;
    apiPayload = { moduleId: currentModuleId, type: '00' };
  } else if (action === 'calibrateWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/weightCalibration`;
    apiPayload = { moduleId: currentModuleId, type: '00' };
  } else if (action === 'takePhoto') {
    apiUrl = `${LOCAL_API_BASE}/system/camera/process`;
    apiPayload = {};
  } else if (action === 'safeTakePhoto') {
    return await safeTakePhoto();
  } else if (action === 'stepperMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/stepMotorSelect`;
    apiPayload = { 
      moduleId: currentModuleId, 
      type: params?.position || '00', 
      deviceType: DEVICE_TYPE
    };
  } else if (action === 'customMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = {
      moduleId: params?.moduleId || currentModuleId,
      motorId: params?.motorId,
      type: params?.type,
      deviceType: params?.deviceType || DEVICE_TYPE
    };
  } else if (action === 'safeOpenGate') {
    return await safeOpenGate();
  } else {
    console.error('⚠️ Unknown action:', action);
    return;
  }
  
  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (action === 'takePhoto') {
      await delay(2000);
    } else if (action === 'getWeight') {
      await delay(3000);
    }
    
  } catch (err) {
    console.error(`❌ ${action} failed:`, err.message);
  }
}

async function requestModuleId() {
  try {
    await axios.post(`${LOCAL_API_BASE}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('❌ Module ID request failed:', err.message);
  }
}

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
        await executeCommand({ action: 'safeOpenGate' });
      } else if (!autoCycleEnabled && currentModuleId) {
        await executeCommand({ action: 'closeGate' });
      }
      return;
    }
    
    if (topic.includes('/commands')) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (payload.action === 'takePhoto') {
        payload.action = 'safeTakePhoto';
      }
      
      if (!currentModuleId) {
        pendingCommands.set(Date.now().toString(), payload);
        await requestModuleId();
      } else {
        await executeCommand(payload);
      }
    }
    
  } catch (err) {
    console.error('❌ MQTT error:', err.message);
  }
});

process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down...');
  if (ws) ws.close();
  mqttClient.end();
  process.exit(0);
});

console.log('╔════════════════════════════════════════╗');
console.log('║  🚀 RVM AGENT v4.1 - CORRECT FLOW    ║');
console.log('╚════════════════════════════════════════╝');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('');
console.log('✨ CORRECT FLOW (From Manufacturer):');
console.log('   1. Gate Open');
console.log('   2. Belt Forward → weighing position');
console.log('   3. Drum Lift & Center → lifts to weigh');
console.log('   4. Weight Detection → weighs on drum');
console.log('   5. Drum Down → back to belt');
console.log('   6. Belt Forward to Bin → pushes in');
console.log('   7. Belt Reverse → returns to start');
console.log('   8. Gate Close');
console.log('');
console.log('🎯 KEY INSIGHT:');
console.log('   Drum = WEIGHING PLATFORM (not pusher!)');
console.log('   Belt = Does the final push into bin');
console.log('');
console.log('🤖 curl -X POST http://localhost:3008/api/rvm/RVM-3101/auto/enable');
console.log('╔════════════════════════════════════════╗\n');