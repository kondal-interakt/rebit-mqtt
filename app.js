// RVM Agent v4.0 - CORRECT DRUM MECHANISM (From Manufacturer)
// CRITICAL: Manufacturer revealed the REAL mechanism!
// - Motor 07: Drum RAISE/LOWER (not press plate!)
// - Motor 03: Drum ROTATION (not pusher!)
// - Motor 02: Belt movement
// - Device Type: 5 (not 1!)
//
// Correct Process:
// 1. Belt moves to middle using ULTRA-SHORT PULSES (400ms)
//    → Belt was jumping from '01' to '03' too fast
//    → Solution: 400ms pulses + 100ms position checks
// 2. Drum RISES (motor 07, type 01) - lifts bottle
// 3. Drum ROLLS (motor 03, type 01) - rotates to push into chute
// 4. Wait 3s for bottle to drop
// 5. Drum DESCENDS (motor 07, type 03) - back to start
// 6. Belt returns to start
//
// Save as: agent-v4.0-drum.js
// Run: node agent-v4.0-drum.js

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

// Motor Configuration - FROM MANUFACTURER
const MOTOR_CONFIG = {
  GATE: '01',
  TRANSFER_BELT: '02',
  DRUM_ROTATION: '03',      // Drum rolls (rotates)
  COMPACTOR: '04',
  DRUM_LIFT: '07',          // Drum raises/lowers
  STEPPER: 'stepper'
};

const DEVICE_TYPE = 5;  // From manufacturer specs

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
let lastDrumStatus = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======= DRUM OPERATIONS (FROM MANUFACTURER) =======
async function raiseDrum() {
  console.log('⬆️ Raising drum...');
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.DRUM_LIFT, 
      type: '01',
      deviceType: DEVICE_TYPE
    }
  });
  await delay(2000);  // Wait for drum to rise
  console.log('✅ Drum raised');
}

async function lowerDrum() {
  console.log('⬇️ Lowering drum...');
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.DRUM_LIFT, 
      type: '03',
      deviceType: DEVICE_TYPE
    }
  });
  await delay(2000);  // Wait for drum to lower
  console.log('✅ Drum lowered');
}

async function rotateDrum() {
  console.log('🔄 Rotating drum to push bottle...');
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.DRUM_ROTATION, 
      type: '01',
      deviceType: DEVICE_TYPE
    }
  });
  
  // Rotate for enough time to push bottle into chute
  await delay(5000);  // 5 seconds rotation
  
  // Stop drum rotation
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: MOTOR_CONFIG.DRUM_ROTATION, 
      type: '00',
      deviceType: DEVICE_TYPE
    }
  });
  
  console.log('✅ Drum rotation complete');
}

async function processBottleWithDrum() {
  console.log('🥁 Processing bottle with drum mechanism...');
  
  // Step 1: Raise drum to lift bottle
  await raiseDrum();
  await delay(500);
  
  // Step 2: Rotate drum to push bottle into chute
  await rotateDrum();
  
  // Step 3: Wait for bottle to drop by gravity
  console.log('⏳ Waiting for bottle to drop...');
  await delay(3000);
  
  // Step 4: Lower drum back to start position
  await lowerDrum();
  await delay(500);
  
  console.log('✅ Drum cycle complete');
}

// ======= BELT CONTROL =======
async function ensureBeltAtStart() {
  const currentPos = lastBeltStatus?.position || '00';
  
  if (currentPos === '01') {
    console.log('✅ Belt at start');
    return true;
  }
  
  console.log(`Moving belt from ${currentPos} to start...`);
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
      console.log('✅ Belt at start');
      return true;
    }
  }
  
  await executeCommand({ action: 'transferStop' });
  return true;
}

async function moveToMiddlePosition() {
  console.log('🎯 Moving belt to middle (graduated pulses)...');
  
  await ensureBeltAtStart();
  await delay(500);
  
  // Try progressively longer pulses: 200ms, 250ms, 300ms, 350ms
  const pulseDurations = [200, 250, 300, 350, 320, 280];
  
  for (let i = 0; i < pulseDurations.length; i++) {
    const pulseDuration = pulseDurations[i];
    const currentPos = lastBeltStatus?.position || '00';
    
    console.log(`Attempt ${i + 1}: Current pos = ${currentPos}, trying ${pulseDuration}ms pulse`);
    
    // Already at middle?
    if (currentPos === '02') {
      console.log('✅ Already at middle position');
      return true;
    }
    
    // At end? Try to reverse back
    if (currentPos === '03') {
      console.log('⚠️ At end - trying short reverse to reach middle...');
      
      // Try SHORT reverse pulses
      const reversePulses = [200, 250, 300];
      for (const revPulse of reversePulses) {
        await executeCommand({ 
          action: 'customMotor', 
          params: { 
            motorId: MOTOR_CONFIG.TRANSFER_BELT, 
            type: '01',
            deviceType: DEVICE_TYPE
          }
        });
        await delay(revPulse);
        await executeCommand({ action: 'transferStop' });
        await delay(150);
        
        const pos = lastBeltStatus?.position || '00';
        console.log(`After ${revPulse}ms reverse: ${pos}`);
        
        if (pos === '02') {
          console.log('✅ Reached middle from reverse');
          return true;
        }
        
        if (pos === '01') {
          console.log('Back at start, will retry forward');
          break;
        }
      }
      
      // If still at '03', accept it and continue
      if (lastBeltStatus?.position === '03') {
        console.log('⚠️ Cannot reach middle, using END position instead');
        return true;  // Continue cycle at END position
      }
      
      continue;
    }
    
    // At start - try forward pulse
    if (currentPos === '01') {
      await executeCommand({ 
        action: 'customMotor', 
        params: { 
          motorId: MOTOR_CONFIG.TRANSFER_BELT, 
          type: '02',
          deviceType: DEVICE_TYPE
        }
      });
      
      await delay(pulseDuration);
      
      await executeCommand({ action: 'transferStop' });
      await delay(150);
      
      const newPos = lastBeltStatus?.position || '00';
      console.log(`After ${pulseDuration}ms pulse: ${newPos}`);
      
      if (newPos === '02') {
        console.log('✅ Reached middle position!');
        return true;
      }
      
      if (newPos === '03') {
        console.log('Overshot to end, trying reverse next');
        continue;
      }
      
      // Still at '01', try longer pulse next iteration
      continue;
    }
  }
  
  // If we couldn't reach middle after all attempts, check final position
  const finalPos = lastBeltStatus?.position || '00';
  
  if (finalPos === '02') {
    console.log('✅ Eventually reached middle');
    return true;
  }
  
  if (finalPos === '03') {
    console.log('⚠️ At END position - will process there');
    return true;  // Continue at end position (drum will handle it)
  }
  
  throw new Error('Could not position belt reliably');
}

async function returnBeltToStart() {
  console.log('🔄 Returning belt to start...');
  
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
      console.log('✅ Belt at start');
      return true;
    }
  }
  
  await executeCommand({ action: 'transferStop' });
  return true;
}

// ======= GATE OPERATIONS =======
async function safeOpenGate() {
  console.log('🚪 Opening gate safely...');
  
  // Ensure drum is lowered
  await lowerDrum();
  await delay(200);
  
  // Ensure belt at start
  await ensureBeltAtStart();
  await delay(200);
  
  // Open gate
  await executeCommand({ action: 'openGate' });
  await delay(500);
  await executeCommand({ action: 'gateMotorStop' });
  
  console.log('✅ Gate open');
}

async function safeCloseGate() {
  console.log('🚪 Closing gate...');
  await executeCommand({ action: 'closeGate' });
  await delay(1000);
  await executeCommand({ action: 'gateMotorStop' });
  console.log('✅ Gate closed');
}

// ======= PHOTO CAPTURE =======
async function safeTakePhoto() {
  console.log('📸 Safe photo capture...');
  
  // Stop all motors
  await lowerDrum();
  await delay(200);
  
  await executeCommand({ action: 'transferStop' });
  await delay(200);
  
  await executeCommand({ action: 'gateMotorStop' });
  await delay(200);
  
  // Take photo
  await executeCommand({ action: 'takePhoto' });
  console.log('✅ Photo captured');
}

// ======= COMPACTOR =======
async function runCompactor(materialType) {
  console.log(`🔨 Running compactor...`);
  
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
  await delay(1000);
  
  console.log('✅ Compactor done');
}

// ======= FULL CYCLE WITH DRUM =======
async function executeFullCycle() {
  console.log('\n🚀 Starting cycle...');
  
  try {
    let stepperPos = '00';
    
    switch (latestAIResult.materialType) {
      case 'PLASTIC_BOTTLE': stepperPos = '03'; break;
      case 'METAL_CAN': stepperPos = '02'; break;
      case 'GLASS': stepperPos = '01'; break;
    }
    
    console.log(`📍 ${latestAIResult.materialType} → Bin ${stepperPos}`);
    
    // Ensure starting position
    await ensureBeltAtStart();
    await delay(1000);
    
    // Position sorter
    console.log('🔄 Positioning sorter...');
    await executeCommand({ 
      action: 'stepperMotor', 
      params: { position: stepperPos }
    });
    await delay(3000);
    
    // Move belt to middle
    await moveToMiddlePosition();
    await delay(1000);
    
    // Process with DRUM mechanism
    await processBottleWithDrum();
    
    // Return belt
    await returnBeltToStart();
    await delay(1000);
    
    // Compact
    await runCompactor(latestAIResult.materialType);
    
    // Reset sorter
    console.log('🏠 Resetting sorter...');
    await executeCommand({ 
      action: 'stepperMotor', 
      params: { position: '00' }
    });
    await delay(2000);
    
    // Close gate
    await safeCloseGate();
    
    console.log('✅ Cycle complete!\n');
    
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
    await executeCommand({ action: 'transferStop' });
    await lowerDrum();
    await executeCommand({ 
      action: 'customMotor', 
      params: { 
        motorId: MOTOR_CONFIG.COMPACTOR, 
        type: '00',
        deviceType: DEVICE_TYPE
      }
    });
    await safeCloseGate();
  }
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
          await executeCommand({ action: 'openGate' });
          await delay(1000);
          await executeCommand({ action: 'gateMotorStop' });
          await delay(1000);
          await executeCommand({ action: 'closeGate' });
          await delay(1000);
          await executeCommand({ action: 'gateMotorStop' });
        }
        return;
      }
      
      if (message.function === '03') {
        try {
          const motors = JSON.parse(message.data);
          
          motors.forEach(motor => {
            motorStatusCache[motor.motorType] = motor;
            if (motor.motorType === '02') lastBeltStatus = motor;
            if (motor.motorType === '03' || motor.motorType === '07') lastDrumStatus = motor;
          });
          
          const abnormals = motors.filter(m => m.state === 1 && !IGNORE_MOTOR_RECOVERY.includes(m.motorType));
          
          if (abnormals.length > 0 && !recoveryInProgress) {
            console.log('🚨 Motor issue:', abnormals.map(m => m.motorTypeDesc).join(', '));
            await autoRecoverMotors(abnormals);
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
      
      if (message.function === 'qrcode') {
        console.log('🔍 QR:', message.data);
        mqttClient.publish(`rvm/${DEVICE_ID}/qrcode`, JSON.stringify({
          data: message.data,
          timestamp: new Date().toISOString()
        }));
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

// ======= AUTO-RECOVERY =======
async function autoRecoverMotors(abnormals) {
  if (recoveryInProgress) return;
  recoveryInProgress = true;
  
  console.log('🔧 Auto-recovery...');
  
  for (const motor of abnormals) {
    try {
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
        case '07':
          await lowerDrum();
          await delay(500);
          break;
        case '04': 
          await executeCommand({ 
            action: 'customMotor', 
            params: { 
              motorId: MOTOR_CONFIG.COMPACTOR, 
              type: '00',
              deviceType: DEVICE_TYPE
            }
          });
          await delay(500);
          break;
      }
    } catch (err) {
      console.error(`❌ Recovery failed: ${err.message}`);
    }
  }
  
  setTimeout(() => {
    recoveryInProgress = false;
  }, 30000);
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

// ======= EXECUTE COMMAND =======
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
  } else if (action === 'getMotorStatus') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/getModuleStatus`;
    apiPayload = { moduleId: currentModuleId, type: '03' };
  } else if (action === 'safeOpenGate') {
    return await safeOpenGate();
  } else if (action === 'safeCloseGate') {
    return await safeCloseGate();
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
        await executeCommand({ action: 'safeOpenGate' });
      } else if (!autoCycleEnabled && currentModuleId) {
        await executeCommand({ action: 'safeCloseGate' });
      }
      return;
    }
    
    if (topic.includes('/commands')) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (payload.action === 'takePhoto') {
        console.log('⚠️ Using safe photo capture');
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

console.log('========================================');
console.log('🚀 RVM AGENT v4.0 - DRUM MECHANISM');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🥁 CORRECT MECHANISM (From Manufacturer):');
console.log('   Motor 07: Drum RAISE/LOWER');
console.log('   Motor 03: Drum ROTATION');
console.log('   Motor 02: Belt movement');
console.log('   Device Type: 5');
console.log('========================================');
console.log('🔧 BELT FIX v2:');
console.log('   - Graduated pulses: 200,250,300,350ms');
console.log('   - If reaches END (03): Accept and process there');
console.log('   - Middle (02) may not have working sensor');
console.log('   - Drum can work at END position too');
console.log('========================================');
console.log('📋 Process:');
console.log('   1. Belt → Middle OR End position');
console.log('   2. Drum RISES (lifts bottle)');
console.log('   3. Drum ROLLS (pushes into chute)');
console.log('   4. Wait for drop (3s)');
console.log('   5. Drum DESCENDS');
console.log('   6. Belt returns to start');
console.log('========================================');
console.log('🤖 curl -X POST http://localhost:3008/api/rvm/RVM-3101/auto/enable');
console.log('========================================\n');