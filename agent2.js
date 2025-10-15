// RVM Agent v5.0 - DRUM/ROLLER SYSTEM
// Based on manufacturer specifications for drum/roller RVM
// Save as: agent-v5.0-drum-system.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= DRUM/ROLLER CONFIGURATION =======
const DRUM_CONFIG = {
  // Drum/Roller motor commands from manufacturer
  drumRise: {
    moduleId: "09",
    motorId: "07", 
    type: "01",
    deviceType: "5"
  },
  drumDescend: {
    moduleId: "09",
    motorId: "07",
    type: "03", 
    deviceType: "5"
  },
  drumRoll: {
    moduleId: "09", 
    motorId: "03",
    type: "01",
    deviceType: "5"
  },
  drumStop: {
    moduleId: "09",
    motorId: "03", 
    type: "00",
    deviceType: "5"
  }
};

// ======= APPLET CONFIGURATIONS =======
const APPLET_CONFIG = {
  weightCoefficients: {
    1: 988,
    2: 942, 
    3: 942,
    4: 942
  },
  timeouts: {
    motor: 10000,
    transfer: 10000,
    pressPlate: 10000
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
let ws = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======= DRUM/ROLLER CONTROL =======
async function drumRise() {
  console.log('🔼 Drum rising...');
  await executeCommand({ 
    action: 'customMotor', 
    params: DRUM_CONFIG.drumRise
  });
  await delay(3000); // Wait for drum to fully rise
  console.log('✅ Drum raised');
}

async function drumDescend() {
  console.log('🔽 Drum descending...');
  await executeCommand({ 
    action: 'customMotor', 
    params: DRUM_CONFIG.drumDescend
  });
  await delay(3000); // Wait for drum to fully descend
  console.log('✅ Drum descended');
}

async function drumRollForward() {
  console.log('🔄 Drum rolling forward...');
  await executeCommand({ 
    action: 'customMotor', 
    params: DRUM_CONFIG.drumRoll
  });
  // Roll for configured time (like applet: 10000ms)
  await delay(APPLET_CONFIG.timeouts.transfer);
  await executeCommand({ 
    action: 'customMotor', 
    params: DRUM_CONFIG.drumStop
  });
  console.log('✅ Drum roll complete');
}

async function drumRollReverse() {
  console.log('🔄 Drum rolling reverse...');
  // For reverse, we might need to check if there's a reverse command
  // If not, we can use the same roll command with different timing
  await executeCommand({ 
    action: 'customMotor', 
    params: DRUM_CONFIG.drumRoll
  });
  await delay(5000); // Shorter time for reverse
  await executeCommand({ 
    action: 'customMotor', 
    params: DRUM_CONFIG.drumStop
  });
  console.log('✅ Drum reverse complete');
}

// ======= BOTTLE TRANSPORT WITH DRUM =======
async function transportBottleToBin() {
  console.log('🎯 Transporting bottle using drum system...');
  
  // Step 1: Ensure drum is in start position (descended)
  await drumDescend();
  await delay(1000);
  
  // Step 2: Roll drum to move bottle forward
  await drumRollForward();
  await delay(1000);
  
  // Step 3: Raise drum to position bottle for pusher
  await drumRise();
  await delay(1000);
  
  console.log('✅ Bottle transported to bin position');
}

async function resetDrumSystem() {
  console.log('🔄 Resetting drum system...');
  
  // Stop any rolling
  await executeCommand({ 
    action: 'customMotor', 
    params: DRUM_CONFIG.drumStop
  });
  
  // Ensure drum is descended
  await drumDescend();
  await delay(1000);
  
  console.log('✅ Drum system reset');
}

// ======= PRESS PLATE CONTROL =======
async function pressPlateOperation() {
  console.log('💪 Press plate operation');
  
  // Press plate DOWN
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: '03', type: '03' }
  });
  
  await delay(APPLET_CONFIG.timeouts.pressPlate);
  
  // Press plate UP
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
  
  const compactorMotor = '04';
  
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

// ======= FULL CYCLE WITH DRUM SYSTEM =======
async function executeFullCycle() {
  console.log('\n🚀 Starting cycle (Drum System)...');
  
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
    
    // Step 2: Transport bottle using DRUM SYSTEM
    await transportBottleToBin();
    await delay(1000);
    
    // Step 3: Push bottle into chute
    await pressPlateOperation();
    await delay(1000);
    
    // Step 4: Reset drum system
    await resetDrumSystem();
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
    await resetDrumSystem();
    await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '00' } });
    await executeCommand({ action: 'customMotor', params: { motorId: '04', type: '00' } });
    await executeCommand({ action: 'closeGate' });
  }
}

// ======= DRUM TEST FUNCTIONS =======
async function testDrumOperations() {
  console.log('\n🧪 Testing Drum Operations...');
  
  console.log('1. Testing drum descend...');
  await drumDescend();
  await delay(2000);
  
  console.log('2. Testing drum roll forward...');
  await drumRollForward();
  await delay(2000);
  
  console.log('3. Testing drum rise...');
  await drumRise();
  await delay(2000);
  
  console.log('4. Testing drum descend again...');
  await drumDescend();
  await delay(2000);
  
  console.log('✅ Drum tests complete');
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
        
        // Apply weight coefficient
        const weightCoefficient = APPLET_CONFIG.weightCoefficients[1];
        const calibratedWeight = weightValue * (weightCoefficient / 1000);
        
        latestWeight = {
          weight: calibratedWeight,
          rawWeight: weightValue,
          coefficient: weightCoefficient,
          timestamp: new Date().toISOString()
        };
        
        console.log(`⚖️ Weight: ${latestWeight.weight}g (raw: ${latestWeight.rawWeight}g)`);
        
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
      deviceType: params?.deviceType || deviceType
    };
  } else if (action === 'drumRise') {
    return await drumRise();
  } else if (action === 'drumDescend') {
    return await drumDescend();
  } else if (action === 'drumRoll') {
    return await drumRollForward();
  } else if (action === 'testDrum') {
    return await testDrumOperations();
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
console.log('🚀 RVM AGENT v5.0 - DRUM/ROLLER SYSTEM');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🎯 DRUM SYSTEM COMMANDS:');
console.log('   Rise:    moduleId:09, motorId:07, type:01');
console.log('   Descend: moduleId:09, motorId:07, type:03'); 
console.log('   Roll:    moduleId:09, motorId:03, type:01');
console.log('========================================');
console.log('🧪 TEST COMMANDS:');
console.log('   POST /api/rvm/RVM-3101/commands -d \'{"action":"testDrum"}\'');
console.log('   POST /api/rvm/RVM-3101/commands -d \'{"action":"drumRise"}\'');
console.log('   POST /api/rvm/RVM-3101/commands -d \'{"action":"drumDescend"}\'');
console.log('   POST /api/rvm/RVM-3101/commands -d \'{"action":"drumRoll"}\'');
console.log('========================================\n');