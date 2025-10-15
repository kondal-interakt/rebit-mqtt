// RVM Agent v4.0 - WITH APPLET CONFIGURATIONS
// Based on RVM configuration applet settings from screenshots
// Save as: agent-v4.0-applet-config.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= APPLET CONFIGURATIONS (FROM SCREENSHOTS) =======
const APPLET_CONFIG = {
  // Motor directions (from screenshot: 开门电机=反方向, 传送电机=反方向, etc.)
  motorDirections: {
    '01': 'reverse',    // 开门电机 - 反方向
    '02': 'reverse',    // 传送电机 - 反方向  
    '03': 'forward',    // 压板电机 - 正方向
    '04': 'reverse',    // 翻板电机 - 反方向
    '05': 'reverse',    // 分装电机 - 反方向
    '06': 'forward'     // 副板开/尾机 - 正方向
  },
  
  // Weight coefficients (from screenshot)
  weightCoefficients: {
    1: 988,
    2: 942, 
    3: 942,
    4: 942
  },
  
  // Motor timeout settings (from screenshot: /10000)
  timeouts: {
    motor: 10000,       // 电机超时时间 /10000
    transfer: 10000,    // 传送电机移动时间 /10000
    pressPlate: 10000   // 压板电机移动时间 /10000
  },
  
  // Sorter motor timing (from screenshot)
  sorterTiming: {
    leftToMiddle: 360,  // 分装电机左-中时间 /360
    rightToMiddle: 45   // 分装电机右-中时间 /45°
  }
};

// ======= CONFIG =======
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
const IGNORE_MOTOR_RECOVERY = ['05'];
let ws = null;
let lastBeltStatus = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======= APPLET-COMPATIBLE MOTOR CONTROL =======
async function transferForwardToBin() {
  console.log('🎯 Transfer forward TO BIN (Applet compatible)');
  
  // Based on applet: 传送电机移动时间 /10000 = 10 seconds
  const transferTime = APPLET_CONFIG.timeouts.transfer;
  
  console.log(`➡️ Continuous forward (${transferTime}ms)...`);
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: '02', type: '02' }  // Forward to limit
  });
  
  // Wait for the configured transfer time OR until position reached
  const startTime = Date.now();
  let positionReached = false;
  
  while (Date.now() - startTime < transferTime) {
    await delay(500);
    
    const pos = lastBeltStatus?.position || '00';
    console.log(`⏳ Belt position: ${pos}`);
    
    // Stop when middle or end position reached
    if (pos === '02' || pos === '03') {
      console.log(`✅ Reached position ${pos} - stopping`);
      await executeCommand({ action: 'transferStop' });
      positionReached = true;
      break;
    }
  }
  
  // Safety stop after timeout
  if (!positionReached) {
    console.log(`⏰ Transfer timeout after ${transferTime}ms - stopping`);
    await executeCommand({ action: 'transferStop' });
  }
  
  return positionReached;
}

async function transferReverseToStart() {
  console.log('🔄 Transfer reverse to START');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: '02', type: '01' }  // Reverse
  });
  
  const startTime = Date.now();
  while (Date.now() - startTime < 8000) {
    await delay(500);
    
    if (lastBeltStatus?.position === '01') {
      console.log('✅ Back at start position');
      await executeCommand({ action: 'transferStop' });
      return true;
    }
  }
  
  await executeCommand({ action: 'transferStop' });
  return true;
}

async function pressPlateOperation() {
  console.log('💪 Press plate operation');
  
  // Press plate DOWN (type 03) - using applet timing
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: '03', type: '03' }
  });
  
  // Wait for press plate movement (using applet timing)
  await delay(APPLET_CONFIG.timeouts.pressPlate);
  
  // Press plate UP (type 01)
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: '03', type: '01' }
  });
  
  await delay(3000);
  
  // Stop press plate
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: '03', type: '00' }
  });
  
  console.log('✅ Press plate operation complete');
}

async function compactorOperation(materialType) {
  console.log(`🔨 Compactor for ${materialType}`);
  
  const compactorMotor = '04'; // Plastic compactor
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: compactorMotor, type: '01' }
  });
  
  await delay(6000);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: compactorMotor, type: '00' }
  });
  
  console.log('✅ Compactor operation complete');
}

// ======= FULL CYCLE WITH APPLET SETTINGS =======
async function executeFullCycle() {
  console.log('\n🚀 Starting cycle (Applet compatible)...');
  
  try {
    let stepperPos = '00';
    
    switch (latestAIResult.materialType) {
      case 'PLASTIC_BOTTLE': stepperPos = '03'; break;
      case 'METAL_CAN': stepperPos = '02'; break;
      case 'GLASS': stepperPos = '01'; break;
    }
    
    console.log(`📍 ${latestAIResult.materialType} → Bin ${stepperPos}`);
    
    // Step 1: Position sorter
    console.log('🔄 Positioning sorter...');
    await executeCommand({ 
      action: 'stepperMotor', 
      params: { position: stepperPos }
    });
    await delay(3000);
    
    // Step 2: Transfer bottle to bin (USING APPLET TIMING)
    await transferForwardToBin();
    await delay(1000);
    
    // Step 3: Push bottle into chute
    await pressPlateOperation();
    await delay(1000);
    
    // Step 4: Return belt to start
    await transferReverseToStart();
    await delay(1000);
    
    // Step 5: Run compactor
    await compactorOperation(latestAIResult.materialType);
    await delay(1000);
    
    // Step 6: Reset sorter to home
    console.log('🏠 Resetting sorter...');
    await executeCommand({ 
      action: 'stepperMotor', 
      params: { position: '00' }
    });
    await delay(2000);
    
    // Step 7: Close gate
    await executeCommand({ action: 'closeGate' });
    await delay(1000);
    
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
    
    // Emergency stop
    await executeCommand({ action: 'transferStop' });
    await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '00' } });
    await executeCommand({ action: 'customMotor', params: { motorId: '04', type: '00' } });
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
        
        // Apply weight coefficient (from applet configuration)
        const weightCoefficient = APPLET_CONFIG.weightCoefficients[1]; // Using weighter 1
        const calibratedWeight = weightValue * (weightCoefficient / 1000);
        
        latestWeight = {
          weight: calibratedWeight,
          rawWeight: weightValue,
          coefficient: weightCoefficient,
          timestamp: new Date().toISOString()
        };
        
        console.log(`⚖️ Weight: ${latestWeight.weight}g (raw: ${latestWeight.rawWeight}g, coeff: ${weightCoefficient})`);
        
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
    apiPayload = { moduleId: currentModuleId, motorId: '02', type: '00', deviceType };
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
console.log('🚀 RVM AGENT v4.0 - APPLET COMPATIBLE');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('⚙️ APPLET CONFIGURATIONS LOADED:');
console.log('   Motor Directions: Reverse for gate/transfer motors');
console.log('   Weight Coefficients: 988, 942, 942, 942');
console.log('   Transfer Time: 10000ms');
console.log('   Press Plate Time: 10000ms');
console.log('========================================');
console.log('🤖 USAGE:');
console.log('   Enable: POST /api/rvm/RVM-3101/auto/enable');
console.log('   Test: POST /api/rvm/RVM-3101/transfer/forward');
console.log('========================================\n');