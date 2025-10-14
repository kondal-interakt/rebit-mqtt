// RVM Agent v3.6 - MATCHES ACTUAL MACHINE CONFIGURATION
// Based on machine config screen analysis:
// - Transfer motor: CW direction
// - Press plate (pusher) motor: CCW  
// - Separate compactors for plastic vs cans
// - Transfer timeout: 5000ms
// Save as: agent-v3.6-config-match.js
// Run: node agent-v3.6-config-match.js

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

// Motor Configuration (from machine config screen)
const MOTOR_CONFIG = {
  GATE: '01',              // Gate motor
  TRANSFER: '02',          // Transfer belt motor (CW direction)
  PRESS_PLATE: '03',       // Press plate (pusher) motor (CCW direction)
  PLASTIC_COMPACTOR: '04', // Plastic compactor
  CANS_COMPACTOR: '05',    // Cans compactor (might be different motor)
  STEPPER: 'stepper'       // Sorter/stepper motor
};

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
let lastPusherStatus = null;

// ======= BELT CONTROL =======
async function ensureBeltAtStart() {
  console.log('🔍 Ensuring belt at start...');
  const currentPos = lastBeltStatus?.position || '00';
  
  if (currentPos === '01') {
    console.log('✅ Belt at start');
    return true;
  }
  
  console.log(`   Moving from ${currentPos} to start...`);
  // Use reverse (type '01') to go to start
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: MOTOR_CONFIG.TRANSFER, type: '01' } 
  });
  
  const startTime = Date.now();
  while (Date.now() - startTime < 10000) {
    await delay(400);
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
  console.log('🎯 Moving to middle position...');
  
  await ensureBeltAtStart();
  await delay(500);
  
  // Try using limit switch mode (type '02' should go to limit)
  console.log('   Using transfer limit command...');
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: MOTOR_CONFIG.TRANSFER, type: '02' } 
  });
  
  const startTime = Date.now();
  let reached = false;
  
  while (Date.now() - startTime < 8000) {
    await delay(400);
    const pos = lastBeltStatus?.position || '00';
    
    if (pos === '02') {
      console.log('✅ Reached middle limit switch');
      await executeCommand({ action: 'transferStop' });
      reached = true;
      break;
    }
    
    // If it went to '03', do a quick reverse
    if (pos === '03') {
      console.log('⚠️ Overshot, quick reverse...');
      await executeCommand({ action: 'transferStop' });
      await delay(300);
      await executeCommand({ 
        action: 'customMotor', 
        params: { motorId: MOTOR_CONFIG.TRANSFER, type: '01' } 
      });
      await delay(800);  // Short reverse
      await executeCommand({ action: 'transferStop' });
      
      if (lastBeltStatus?.position === '02') {
        reached = true;
        break;
      }
    }
  }
  
  await executeCommand({ action: 'transferStop' });
  
  if (!reached) {
    throw new Error('Could not reach middle position');
  }
  
  return true;
}

async function returnToStart() {
  console.log('🔄 Returning to start...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: MOTOR_CONFIG.TRANSFER, type: '01' } 
  });
  
  const startTime = Date.now();
  while (Date.now() - startTime < 10000) {
    await delay(400);
    if (lastBeltStatus?.position === '01') {
      await executeCommand({ action: 'transferStop' });
      console.log('✅ Back at start');
      return true;
    }
  }
  
  await executeCommand({ action: 'transferStop' });
  return true;
}

// ======= PRESS PLATE (PUSHER) CONTROL =======
async function pushBottleIntoChute() {
  console.log('💪 Pushing bottle into chute...');
  
  // Press plate DOWN (type '03' = to end position)
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: MOTOR_CONFIG.PRESS_PLATE, type: '03' } 
  });
  
  // Wait for push (8 seconds for full ejection)
  await delay(8000);
  
  // Wait for gravity
  console.log('⏳ Waiting for bottle to drop...');
  await delay(3000);
  
  // Press plate UP (type '01' = reverse/retract)
  console.log('↑ Retracting press plate...');
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: MOTOR_CONFIG.PRESS_PLATE, type: '01' } 
  });
  
  await delay(3000);  // Wait for retraction
  
  // Stop press plate
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: MOTOR_CONFIG.PRESS_PLATE, type: '00' } 
  });
  
  await delay(500);
  console.log('✅ Push complete');
}

// ======= COMPACTOR CONTROL =======
async function runCompactor(materialType) {
  console.log(`🔨 Running ${materialType} compactor...`);
  
  let compactorMotor;
  
  // Use correct compactor based on material
  if (materialType === 'PLASTIC_BOTTLE') {
    compactorMotor = MOTOR_CONFIG.PLASTIC_COMPACTOR;  // Motor '04'
  } else if (materialType === 'METAL_CAN') {
    compactorMotor = MOTOR_CONFIG.CANS_COMPACTOR;     // Motor '05' or same as '04'
  } else {
    compactorMotor = MOTOR_CONFIG.PLASTIC_COMPACTOR;  // Default
  }
  
  // Start compactor (try type '01' first, as shown in config)
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: compactorMotor, type: '01' } 
  });
  
  await delay(6000);  // Run for 6 seconds
  
  // Stop compactor
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: compactorMotor, type: '00' } 
  });
  
  await delay(1000);
  console.log('✅ Compactor done');
}

// ======= FULL CYCLE =======
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
    
    // Step 0: Ensure starting position
    await ensureBeltAtStart();
    await delay(1000);
    
    // Step 1: Position sorter/stepper
    console.log('🔄 Positioning sorter...');
    await executeCommand({ 
      action: 'stepperMotor', 
      params: { position: stepperPos } 
    });
    await delay(3000);
    
    // Step 2: Move belt to middle
    await moveToMiddlePosition();
    await delay(1000);
    
    // Step 3: Push bottle with press plate
    await pushBottleIntoChute();
    
    // Step 4: Return belt to start
    await returnToStart();
    await delay(1000);
    
    // Step 5: Run appropriate compactor
    await runCompactor(latestAIResult.materialType);
    
    // Step 6: Reset sorter to home
    console.log('🏠 Resetting sorter...');
    await executeCommand({ 
      action: 'stepperMotor', 
      params: { position: '00' } 
    });
    await delay(2000);
    
    // Step 7: Close gate
    await executeCommand({ action: 'closeGate' });
    
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
    await executeCommand({ 
      action: 'customMotor', 
      params: { motorId: MOTOR_CONFIG.PRESS_PLATE, type: '00' } 
    });
    await executeCommand({ 
      action: 'customMotor', 
      params: { motorId: MOTOR_CONFIG.PLASTIC_COMPACTOR, type: '00' } 
    });
    await executeCommand({ action: 'closeGate' });
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
          console.log(`⚠️ Too light (${latestWeight.weight}g) - rejecting`);
          await executeCommand({ action: 'openGate' });
          setTimeout(() => executeCommand({ action: 'closeGate' }), 2000);
        }
        return;
      }
      
      if (message.function === '03') {
        try {
          const motors = JSON.parse(message.data);
          
          motors.forEach(motor => {
            motorStatusCache[motor.motorType] = motor;
            if (motor.motorType === '02') lastBeltStatus = motor;
            if (motor.motorType === '03') lastPusherStatus = motor;
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
          setTimeout(() => executeCommand({ action: 'takePhoto' }), 1000);
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
          await executeCommand({ 
            action: 'customMotor', 
            params: { motorId: MOTOR_CONFIG.PRESS_PLATE, type: '00' } 
          });
          await delay(500);
          break;
        case '04': 
          await executeCommand({ 
            action: 'customMotor', 
            params: { motorId: MOTOR_CONFIG.PLASTIC_COMPACTOR, type: '00' } 
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
  } else if (action === 'transferStop') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: MOTOR_CONFIG.TRANSFER, type: '00', deviceType };
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
  } else if (action === 'getMotorStatus') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/getModuleStatus`;
    apiPayload = { moduleId: currentModuleId, type: '03' };
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
        await executeCommand({ action: 'openGate' });
      } else if (!autoCycleEnabled && currentModuleId) {
        await executeCommand({ action: 'closeGate' });
      }
      return;
    }
    
    if (topic.includes('/commands')) {
      console.log(`📩 Command: ${payload.action}`);
      
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
console.log('🚀 RVM AGENT v3.6 - CONFIG MATCHED');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🔧 Based on actual machine configuration:');
console.log('   - Transfer motor: CW direction');
console.log('   - Press plate (pusher): CCW direction');
console.log('   - Plastic compactor: Motor 04');
console.log('   - Cans compactor: Motor 05 (separate)');
console.log('   - Transfer timeout: 5000ms');
console.log('========================================');
console.log('📋 Sequence:');
console.log('   Start → Sorter → Middle → PRESS → Wait');
console.log('   → Retract → Return → Compact → Reset');
console.log('========================================');
console.log('🤖 curl -X POST http://localhost:3008/api/rvm/RVM-3101/auto/enable');
console.log('========================================\n');