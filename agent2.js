// RVM Agent v6.0 - COMBINED DRUM & BELT SYSTEM
// Keep existing API endpoints, update internal logic only
// Save as: agent-v6.0-combined-system.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= COMBINED SYSTEM CONFIGURATION =======
const SYSTEM_CONFIG = {
  // Drum commands (from manufacturer)
  drum: {
    rise: { moduleId: "09", motorId: "07", type: "01", deviceType: "5" },
    descend: { moduleId: "09", motorId: "07", type: "03", deviceType: "5" },
    roll: { moduleId: "09", motorId: "03", type: "01", deviceType: "5" },
    stop: { moduleId: "09", motorId: "03", type: "00", deviceType: "5" }
  },
  
  // Belt commands (from technical document)
  belt: {
    forward: { motorId: "02", type: "02" }, // Forward to limit
    reverse: { motorId: "02", type: "01" }, // Reverse
    stop: { motorId: "02", type: "00" },    // Stop
    toCollectBin: { motorId: "03", type: "03" } // Pusher to bin
  },
  
  // Applet configurations
  applet: {
    weightCoefficients: { 1: 988, 2: 942, 3: 942, 4: 942 },
    timeouts: { motor: 10000, transfer: 10000, pressPlate: 10000 }
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
async function drumRise() {
  console.log('🔼 Drum rising to receive bottle...');
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.drum.rise
  });
  await delay(3000);
  console.log('✅ Drum raised');
}

async function drumDescend() {
  console.log('🔽 Drum descending to place bottle...');
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.drum.descend
  });
  await delay(3000);
  console.log('✅ Drum descended');
}

async function drumRoll() {
  console.log('🔄 Drum rolling...');
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.drum.roll
  });
  await delay(2000);
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.drum.stop
  });
  console.log('✅ Drum roll complete');
}

// ======= BELT CONTROL =======
async function beltForwardToBin() {
  console.log('🎯 Belt moving forward to bin...');
  
  // Start belt forward movement
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: SYSTEM_CONFIG.belt.forward.motorId,
      type: SYSTEM_CONFIG.belt.forward.type
    }
  });
  
  // Monitor belt position while moving
  const startTime = Date.now();
  let positionReached = false;
  
  while (Date.now() - startTime < SYSTEM_CONFIG.applet.timeouts.transfer) {
    await delay(500);
    
    const pos = lastBeltStatus?.position || '00';
    console.log(`⏳ Belt position: ${pos}`);
    
    // Stop when middle position reached (ready for drum placement)
    if (pos === '02') {
      console.log('✅ Belt at middle position - ready for drum');
      await executeCommand({ 
        action: 'customMotor', 
        params: SYSTEM_CONFIG.belt.stop
      });
      positionReached = true;
      break;
    }
    
    // If end position reached, we overshot
    if (pos === '03') {
      console.log('⚠️ Belt overshot - reversing slightly');
      await executeCommand({ 
        action: 'customMotor', 
        params: SYSTEM_CONFIG.belt.stop
      });
      await delay(300);
      
      // Quick reverse to middle
      await executeCommand({ 
        action: 'customMotor', 
        params: { 
          motorId: SYSTEM_CONFIG.belt.reverse.motorId,
          type: SYSTEM_CONFIG.belt.reverse.type
        }
      });
      await delay(1000);
      await executeCommand({ 
        action: 'customMotor', 
        params: SYSTEM_CONFIG.belt.stop
      });
      positionReached = true;
      break;
    }
  }
  
  // Safety stop
  if (!positionReached) {
    console.log('⏰ Belt timeout - stopping');
    await executeCommand({ 
      action: 'customMotor', 
      params: SYSTEM_CONFIG.belt.stop
    });
  }
  
  return positionReached;
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
  
  const startTime = Date.now();
  while (Date.now() - startTime < 8000) {
    await delay(500);
    
    if (lastBeltStatus?.position === '01') {
      console.log('✅ Belt back at start position');
      await executeCommand({ 
        action: 'customMotor', 
        params: SYSTEM_CONFIG.belt.stop
      });
      return true;
    }
  }
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  return true;
}

// ======= COMBINED TRANSPORT SEQUENCE =======
async function transportBottleToBin() {
  console.log('🚚 Combined transport: Drum + Belt');
  
  // Step 1: Drum rises to lift bottle from gate area
  await drumRise();
  await delay(1000);
  
  // Step 2: Belt moves bottle INSIDE the machine
  await beltForwardToBin();
  await delay(1000);
  
  // Step 3: Drum descends to place bottle into bin position
  await drumDescend();
  await delay(1000);
  
  // Step 4: Optional: Drum rolls to ensure bottle placement
  await drumRoll();
  await delay(1000);
  
  console.log('✅ Bottle transported and placed into bin position');
}

// ======= PUSHER & COMPACTOR =======
async function pushBottleIntoBin() {
  console.log('💪 Pusher moving bottle into bin...');
  
  // Use pusher motor to push bottle from belt into actual bin
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: SYSTEM_CONFIG.belt.toCollectBin.motorId,
      type: SYSTEM_CONFIG.belt.toCollectBin.type
    }
  });
  
  await delay(4000);
  
  // Stop pusher
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

// ======= FULL CYCLE - COMBINED SYSTEM =======
async function executeFullCycle() {
  console.log('\n🚀 Starting cycle (Drum + Belt System)...');
  
  try {
    let stepperPos = '00';
    
    switch (latestAIResult.materialType) {
      case 'PLASTIC_BOTTLE': stepperPos = '03'; break;
      case 'METAL_CAN': stepperPos = '02'; break;
      case 'GLASS': stepperPos = '01'; break;
    }
    
    console.log(`📍 ${latestAIResult.materialType} → Bin ${stepperPos}`);
    
    // Step 1: Position sorter to correct bin
    console.log('🔄 Positioning sorter...');
    await executeCommand({ 
      action: 'stepperMotor', 
      params: { position: stepperPos }
    });
    await delay(3000);
    
    // Step 2: COMBINED TRANSPORT - Drum lifts, belt moves, drum places
    await transportBottleToBin();
    await delay(1000);
    
    // Step 3: Push bottle into actual bin
    await pushBottleIntoBin();
    await delay(1000);
    
    // Step 4: Return belt to start position
    await beltReverseToStart();
    await delay(1000);
    
    // Step 5: Run compactor
    await compactorOperation();
    await delay(1000);
    
    // Step 6: Reset sorter to home
    console.log('🏠 Resetting sorter...');
    await executeCommand({ 
      action: 'stepperMotor', 
      params: { position: '00' }
    });
    await delay(2000);
    
    // Step 7: Ensure drum is in start position (descended)
    await drumDescend();
    await delay(1000);
    
    // Step 8: Close gate
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
    
    // Emergency stop all systems
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.belt.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.drum.stop });
    await executeCommand({ action: 'customMotor', params: { motorId: '03', type: '00' } });
    await executeCommand({ action: 'customMotor', params: { motorId: '04', type: '00' } });
    await drumDescend(); // Ensure drum is down
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
console.log('🚀 RVM AGENT v6.0 - COMBINED SYSTEM');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🔄 COMBINED DRUM + BELT SYSTEM:');
console.log('   1. Drum rises to lift bottle');
console.log('   2. Belt moves bottle inside machine'); 
console.log('   3. Drum descends to place bottle');
console.log('   4. Pusher moves bottle into bin');
console.log('========================================');
console.log('🤖 AUTO MODE:');
console.log('   Enable: POST /api/rvm/RVM-3101/auto/enable');
console.log('   Status: GET /api/rvm/RVM-3101/auto/status');
console.log('========================================\n');