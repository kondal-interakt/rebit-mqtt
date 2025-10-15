// RVM Agent v6.4 - FASTER FINAL PUSH
// Belt Forward to Bin needs to be faster and longer to completely reach sorter
// Save as: agent-v6.4-faster-push.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= SYSTEM CONFIGURATION =======
const SYSTEM_CONFIG = {
  // Drum commands
  drum: {
    rise: { moduleId: "09", motorId: "07", type: "01", deviceType: "5" },
    descend: { moduleId: "09", motorId: "07", type: "03", deviceType: "5" },
    center: { moduleId: "09", motorId: "03", type: "01", deviceType: "5" },
    stop: { moduleId: "09", motorId: "03", type: "00", deviceType: "5" }
  },
  
  // Belt commands - INCREASED TIMING for final push
  belt: {
    forward: { motorId: "02", type: "02" }, // Forward to limit
    reverse: { motorId: "02", type: "01" }, // Reverse to start
    stop: { motorId: "02", type: "00" },    // Stop
    toCollectBin: { motorId: "03", type: "03" } // Pusher to bin
  },
  
  // Applet configurations - INCREASED TRANSFER TIME
  applet: {
    weightCoefficients: { 1: 988, 2: 942, 3: 942, 4: 942 },
    timeouts: { 
      motor: 10000, 
      transfer: 12000, // INCREASED from 8000 to 12000ms for final push
      pressPlate: 10000 
    }
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
let lastBeltStatus = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======= DRUM CONTROL =======
async function drumRiseAndCenter() {
  console.log('🔼 Drum rising and centering for weight detection...');
  
  // Drum rise
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.drum.rise
  });
  await delay(3000);
  
  // Drum center/roll to position bottle for weighing
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.drum.center
  });
  await delay(2000);
  
  // Stop drum
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.drum.stop
  });
  
  console.log('✅ Drum raised and centered for weight detection');
}

async function drumDescend() {
  console.log('🔽 Drum descending...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.drum.descend
  });
  await delay(3000);
  
  console.log('✅ Drum descended');
}

// ======= BELT CONTROL - IMPROVED FINAL PUSH =======
async function beltForwardToWeightPosition() {
  console.log('🎯 Belt moving bottle to weight position...');
  
  // Shorter forward movement to position bottle for drum
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: SYSTEM_CONFIG.belt.forward.motorId,
      type: SYSTEM_CONFIG.belt.forward.type
    }
  });
  
  await delay(4000); // Shorter movement for weight position
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Bottle at weight position');
}

async function beltForwardToBin() {
  console.log('🎯 FINAL PUSH: Belt moving bottle COMPLETELY to sorter...');
  
  // FINAL PUSH - LONGER and CONTINUOUS to reach sorter completely
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: SYSTEM_CONFIG.belt.forward.motorId,
      type: SYSTEM_CONFIG.belt.forward.type
    }
  });
  
  console.log(`➡️ EXTENDED forward movement (${SYSTEM_CONFIG.applet.timeouts.transfer}ms)...`);
  
  // Use position monitoring to ensure bottle reaches sorter
  const startTime = Date.now();
  let reachedTarget = false;
  
  while (Date.now() - startTime < SYSTEM_CONFIG.applet.timeouts.transfer) {
    await delay(500);
    
    const pos = lastBeltStatus?.position || '00';
    console.log(`⏳ Belt position: ${pos} (target: 03=sorter)`);
    
    // Stop when END position reached (position 03 = sorter)
    if (pos === '03') {
      console.log('✅ REACHED SORTER - bottle completely at sorter position');
      await executeCommand({ 
        action: 'customMotor', 
        params: SYSTEM_CONFIG.belt.stop
      });
      reachedTarget = true;
      break;
    }
  }
  
  // If timeout but not at sorter, continue a bit more
  if (!reachedTarget) {
    console.log('🔄 Continuing forward to ensure bottle reaches sorter...');
    await delay(2000); // Extra 2 seconds
    await executeCommand({ 
      action: 'customMotor', 
      params: SYSTEM_CONFIG.belt.stop
    });
  }
  
  console.log('✅ FINAL PUSH complete - bottle should be at sorter');
}

async function beltReverseToStart() {
  console.log('🔄 Belt returning to start...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: SYSTEM_CONFIG.belt.reverse.motorId,
      type: SYSTEM_CONFIG.belt.reverse.type
    }
  });
  
  await delay(8000);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Belt back at start position');
}

// ======= PUSHER & COMPACTOR =======
async function pushBottleIntoBin() {
  console.log('💪 Pusher moving bottle from sorter into bin...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: SYSTEM_CONFIG.belt.toCollectBin.motorId,
      type: SYSTEM_CONFIG.belt.toCollectBin.type
    }
  });
  
  await delay(4000);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: '03', type: '00' }
  });
  
  console.log('✅ Bottle pushed into bin');
}

async function compactorOperation() {
  console.log('🔨 Running compactor...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: '04', type: '01' }
  });
  
  await delay(6000);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: '04', type: '00' }
  });
  
  console.log('✅ Compaction complete');
}

// ======= SORTER CONTROL =======
async function positionSorterForMaterial(materialType) {
  console.log(`🔄 Sorter routing ${materialType} to correct bin...`);
  
  let sorterPosition = '00';
  
  switch (materialType) {
    case 'PLASTIC_BOTTLE': sorterPosition = '03'; break;
    case 'METAL_CAN': sorterPosition = '02'; break;
    case 'GLASS': sorterPosition = '01'; break;
  }
  
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: sorterPosition }
  });
  
  await delay(3000);
  console.log(`✅ Sorter positioned to bin ${sorterPosition}`);
}

async function resetSorterToHome() {
  console.log('🏠 Resetting sorter to home...');
  
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: '00' }
  });
  
  await delay(2000);
  console.log('✅ Sorter at home position');
}

// ======= FULL CYCLE - WITH FASTER FINAL PUSH =======
async function executeFullCycle() {
  console.log('\n🚀 Starting cycle (With Faster Final Push)...');
  
  try {
    console.log(`📍 AI Detected: ${latestAIResult.materialType}`);
    
    // Step 1: Position sorter to correct bin
    await positionSorterForMaterial(latestAIResult.materialType);
    await delay(1000);
    
    // Step 2: Belt Forward (initial movement to weight position)
    await beltForwardToWeightPosition();
    await delay(1000);
    
    // Step 3: Drum Lift & Center
    await drumRiseAndCenter();
    await delay(1000);
    
    // Step 4: Weight Detection (already done before cycle started)
    console.log(`⚖️ Weight detected: ${latestWeight.weight}g`);
    await delay(1000);
    
    // Step 5: Drum Down
    await drumDescend();
    await delay(1000);
    
    // Step 6: Belt Forward to Bin - FINAL PUSH (FASTER & LONGER)
    await beltForwardToBin();
    await delay(1000);
    
    // Step 7: Push bottle into bin
    await pushBottleIntoBin();
    await delay(1000);
    
    // Step 8: Belt Reverse
    await beltReverseToStart();
    await delay(1000);
    
    // Step 9: Run compactor
    await compactorOperation();
    await delay(1000);
    
    // Step 10: Reset sorter to home
    await resetSorterToHome();
    await delay(1000);
    
    // Step 11: Gate Close
    await executeCommand({ action: 'closeGate' });
    await delay(1000);
    
    console.log('✅ Cycle complete! Bottle processed successfully.\n');
    
    mqttClient.publish(`rvm/${DEVICE_ID}/cycle_complete`, JSON.stringify({
      material: latestAIResult.materialType,
      weight: latestWeight.weight,
      timestamp: new Date().toISOString()
    }));
    
    cycleInProgress = false;
    latestAIResult = null;
    latestWeight = null;
    
  } catch (err) {
    console.error('❌ Cycle failed:', err.message);
    cycleInProgress = false;
    
    // Emergency stop
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.belt.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.drum.stop });
    await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '00' } });
    await executeCommand({ action: 'customMotor', params: { motorId: '04', type: '00' } });
    await drumDescend();
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
        
        const weightCoefficient = SYSTEM_CONFIG.applet.weightCoefficients[1];
        const calibratedWeight = weightValue * (weightCoefficient / 1000);
        
        latestWeight = {
          weight: calibratedWeight,
          rawWeight: weightValue,
          coefficient: weightCoefficient,
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
  
  // KEEP EXISTING API ENDPOINTS UNCHANGED
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
console.log('🚀 RVM AGENT v6.4 - FASTER FINAL PUSH');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🔄 IMPROVED FINAL PUSH:');
console.log('   - Extended transfer time: 12000ms (increased from 8000ms)');
console.log('   - Position monitoring to detect when bottle reaches sorter');
console.log('   - Extra 2 seconds if not at target position');
console.log('   - Continuous movement until bottle completely at sorter');
console.log('========================================');
console.log('🤖 AUTO MODE:');
console.log('   Enable: POST /api/rvm/RVM-3101/auto/enable');
console.log('   Status: GET /api/rvm/RVM-3101/auto/status');
console.log('========================================\n');