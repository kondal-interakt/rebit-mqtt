// RVM Agent v6.7 - FINAL FIX: Added Pusher Motor
// Belt moves bottle to sorter, then PUSHER (Motor 03) pushes it into bin
// Save as: agent-v6.7-with-pusher.js

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
  
  // Belt and Pusher commands
  belt: {
    forward: { motorId: "02", type: "02" },
    reverse: { motorId: "02", type: "01" },
    stop: { motorId: "02", type: "00" }
  },
  
  pusher: {
    push: { motorId: "03", type: "03" },  // Push bottle into bin
    stop: { motorId: "03", type: "00" }   // Stop pusher
  },
  
  compactor: {
    start: { motorId: "04", type: "01" },
    stop: { motorId: "04", type: "00" }
  },
  
  // Timing configurations
  applet: {
    weightCoefficients: { 1: 988, 2: 942, 3: 942, 4: 942 },
    timeouts: { 
      motor: 10000,
      beltToWeightPosition: 3000,
      beltToSorter: 8000,        // Time to reach sorter position
      pusherToBin: 4000,         // Time for pusher to push into bin
      beltReverse: 10000,
      drumRise: 3000,
      drumCenter: 2000,
      drumDescend: 3000,
      compactor: 6000,
      sorter: 3000
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
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.drum.rise
  });
  await delay(SYSTEM_CONFIG.applet.timeouts.drumRise);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.drum.center
  });
  await delay(SYSTEM_CONFIG.applet.timeouts.drumCenter);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.drum.stop
  });
  
  console.log('✅ Drum raised and centered');
}

async function drumDescend() {
  console.log('🔽 Drum descending...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.drum.descend
  });
  await delay(SYSTEM_CONFIG.applet.timeouts.drumDescend);
  
  console.log('✅ Drum descended');
}

// ======= BELT CONTROL =======
async function beltForwardToWeightPosition() {
  console.log('🎯 Step 2: Belt moving bottle to weight position...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: SYSTEM_CONFIG.belt.forward.motorId,
      type: SYSTEM_CONFIG.belt.forward.type
    }
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.beltToWeightPosition);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Bottle at weight position');
  await delay(500);
}

async function beltForwardToSorter() {
  console.log('🎯 Step 6: Belt moving bottle to SORTER position...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: SYSTEM_CONFIG.belt.forward.motorId,
      type: SYSTEM_CONFIG.belt.forward.type
    }
  });
  
  console.log(`   Running for ${SYSTEM_CONFIG.applet.timeouts.beltToSorter}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.beltToSorter);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Bottle at SORTER position (sensor 3)');
  await delay(500);
}

async function pushBottleIntoBin() {
  console.log('💪 Step 7: PUSHER pushing bottle from sorter INTO bin...');
  console.log('   🔧 Using Motor 03 (Press Plate/Pusher)');
  
  // Activate pusher motor
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: SYSTEM_CONFIG.pusher.push.motorId,
      type: SYSTEM_CONFIG.pusher.push.type
    }
  });
  
  console.log(`   Pushing for ${SYSTEM_CONFIG.applet.timeouts.pusherToBin}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.pusherToBin);
  
  // Stop pusher
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.pusher.stop
  });
  
  console.log('✅ Bottle PUSHED into bin!');
  await delay(500);
}

async function beltReverseToStart() {
  console.log('🔄 Step 8: Belt returning to start...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: { 
      motorId: SYSTEM_CONFIG.belt.reverse.motorId,
      type: SYSTEM_CONFIG.belt.reverse.type
    }
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.beltReverse);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Belt at start position');
  await delay(500);
}

// ======= COMPACTOR =======
async function compactorOperation() {
  console.log('🔨 Step 9: Running compactor...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.start
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.compactor);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.stop
  });
  
  console.log('✅ Compaction complete');
}

// ======= SORTER CONTROL =======
async function positionSorterForMaterial(materialType) {
  console.log(`🔄 Positioning stepper motor (sorter) for ${materialType}...`);
  
  let sorterPosition = '03'; // Default to plastic
  
  switch (materialType) {
    case 'PLASTIC_BOTTLE': 
      sorterPosition = '03'; 
      console.log('   → Plastic bottle bin (position 03)');
      break;
    case 'METAL_CAN': 
      sorterPosition = '02'; 
      console.log('   → Metal can bin (position 02)');
      break;
    case 'GLASS': 
      sorterPosition = '01'; 
      console.log('   → Glass bin (position 01)');
      break;
  }
  
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: sorterPosition }
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.sorter);
  console.log(`✅ Sorter positioned to bin ${sorterPosition}`);
}

async function resetSorterToHome() {
  console.log('🏠 Resetting sorter to home position...');
  
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: '01' } // Return to origin
  });
  
  await delay(2000);
  console.log('✅ Sorter at home');
}

// ======= FULL CYCLE - WITH PUSHER =======
async function executeFullCycle() {
  console.log('\n========================================');
  console.log('🚀 STARTING CYCLE - WITH PUSHER');
  console.log('========================================');
  console.log(`📍 Material: ${latestAIResult.materialType}`);
  console.log(`⚖️ Weight: ${latestWeight.weight}g`);
  console.log('========================================\n');
  
  try {
    // STEP 1: Gate Open
    console.log('▶️ Step 1: Opening gate...');
    await executeCommand({ action: 'openGate' });
    await delay(1000);
    console.log('✅ Gate opened\n');
    
    // Position sorter BEFORE bottle arrives
    await positionSorterForMaterial(latestAIResult.materialType);
    await delay(500);
    
    // STEP 2: Belt Forward to Weight Position
    await beltForwardToWeightPosition();
    await delay(500);
    
    // STEP 3: Drum Up
    console.log('▶️ Step 3: Drum lifting...');
    await drumRiseAndCenter();
    await delay(500);
    
    // STEP 4: Weight Confirmed
    console.log('▶️ Step 4: Weight confirmed');
    console.log(`   ⚖️ ${latestWeight.weight}g\n`);
    await delay(500);
    
    // STEP 5: Drum Down
    console.log('▶️ Step 5: Drum descending...');
    await drumDescend();
    await delay(500);
    console.log('✅ Drum lowered\n');
    
    // STEP 6: Belt Forward to Sorter (stops at sensor 3)
    await beltForwardToSorter();
    await delay(1000);
    
    // STEP 7: PUSHER - Push bottle INTO bin (CRITICAL!)
    await pushBottleIntoBin();
    await delay(1000);
    
    // STEP 8: Belt Reverse
    await beltReverseToStart();
    await delay(500);
    
    // STEP 9: Compactor (optional)
    await compactorOperation();
    await delay(500);
    
    // STEP 10: Reset sorter
    await resetSorterToHome();
    await delay(500);
    
    // STEP 11: Gate Close
    console.log('▶️ Step 10: Closing gate...');
    await executeCommand({ action: 'closeGate' });
    await delay(1000);
    console.log('✅ Gate closed\n');
    
    console.log('========================================');
    console.log('✅ CYCLE COMPLETE!');
    console.log('========================================\n');
    
    mqttClient.publish(`rvm/${DEVICE_ID}/cycle_complete`, JSON.stringify({
      material: latestAIResult.materialType,
      weight: latestWeight.weight,
      timestamp: new Date().toISOString()
    }));
    
    cycleInProgress = false;
    latestAIResult = null;
    latestWeight = null;
    
  } catch (err) {
    console.error('========================================');
    console.error('❌ CYCLE FAILED:', err.message);
    console.error('========================================\n');
    cycleInProgress = false;
    
    // Emergency stop all motors
    console.log('🛑 Emergency stop...');
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.belt.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.drum.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.pusher.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.compactor.stop });
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
          setTimeout(() => executeFullCycle(), 1000);
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
          // Ignore
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
console.log('🚀 RVM AGENT v6.7 - WITH PUSHER MOTOR');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('✅ COMPLETE SEQUENCE:');
console.log('   1. Gate Open');
console.log('   2. Belt Forward (3s to weight)');
console.log('   3. Drum Up');
console.log('   4. Weight Detection');
console.log('   5. Drum Down');
console.log('   6. Belt Forward (8s to sorter)');
console.log('   7. PUSHER pushes bottle into bin 💪');
console.log('   8. Belt Reverse');
console.log('   9. Compactor');
console.log('   10. Gate Close');
console.log('========================================');
console.log('🔧 KEY FIX:');
console.log('   Motor 03 (Pusher) now pushes bottle');
console.log('   from sorter INTO the bin!');
console.log('========================================\n');