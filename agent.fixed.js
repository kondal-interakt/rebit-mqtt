// RVM Agent v7.0 - FINAL CORRECT VERSION
// Matches flowchart exactly: Belt → Weight → Motor 03 Push to Basket → Stepper Dumps
// NO DRUM OPERATIONS
// Save as: agent-v7.0-final.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= SYSTEM CONFIGURATION =======
const SYSTEM_CONFIG = {
  // Belt commands
  belt: {
    forward: { motorId: "02", type: "02" },      // Belt forward
    reverse: { motorId: "02", type: "01" },      // Belt reverse
    stop: { motorId: "02", type: "00" }          // Belt stop
  },
  
  // Pusher command (pushes bottle FROM belt TO white basket)
  pusher: {
    toBasket: { motorId: "03", type: "03" },     // Push to roller/basket
    stop: { motorId: "03", type: "00" }          // Stop pusher
  },
  
  // Compactor commands
  compactor: {
    forward: { motorId: "04", type: "01" },      // Compact forward
    reverse: { motorId: "04", type: "02" },      // Compact reverse
    stop: { motorId: "04", type: "00" }          // Stop compactor
  },
  
  // Timing configurations
  applet: {
    weightCoefficients: { 1: 988, 2: 942, 3: 942, 4: 942 },
    timeouts: { 
      beltForward: 4000,        // Belt forward to weight position
      pusherToBasket: 5000,     // Pusher pushes bottle to white basket
      beltReverse: 8000,        // Belt reverse to start
      compactorForward: 6000,   // Compactor crush time
      compactorReverse: 3000,   // Compactor reverse time
      stepperRotate: 4000,      // Stepper motor rotate/dump time
      stepperReset: 2000        // Stepper reset to home
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
let autoCycleEnabled = false;
let cycleInProgress = false;
let calibrationAttempts = 0;
let ws = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======= STEP 1: BELT FORWARD TO WEIGHT =======
async function beltForwardToWeight() {
  console.log('▶️ Step 1: Belt moving bottle to weight position...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.forward
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.beltForward);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Bottle at weight position\n');
  await delay(500);
}

// ======= STEP 2: WEIGHT DETECTION (automatic) =======
// Weight detection happens automatically via WebSocket

// ======= STEP 3: AI DETECTION (automatic) =======
// AI detection happens automatically via WebSocket

// ======= STEP 4: PUSHER - PUSH TO WHITE BASKET =======
async function pushBottleToBasket() {
  console.log('▶️ Step 4: PUSHER pushing bottle FROM belt TO white basket...');
  console.log('   🔧 Motor 03 Type 03 - Forward to Roller');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.pusher.toBasket
  });
  
  console.log(`   ⏳ Pushing for ${SYSTEM_CONFIG.applet.timeouts.pusherToBasket}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.pusherToBasket);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.pusher.stop
  });
  
  console.log('✅ Bottle pushed onto white basket!\n');
  await delay(1000);
}

// ======= STEP 5: STEPPER MOTOR - ROTATE TO DUMP =======
async function stepperDumpIntoCrusher(materialType) {
  console.log('▶️ Step 5: STEPPER MOTOR rotating white basket to dump...');
  
  let sorterPosition = '03'; // Default plastic
  
  switch (materialType) {
    case 'PLASTIC_BOTTLE': 
      sorterPosition = '03'; 
      console.log('   🔵 Rotating to PLASTIC crusher (position 03)');
      break;
    case 'METAL_CAN': 
      sorterPosition = '02'; 
      console.log('   🟡 Rotating to METAL crusher (position 02)');
      break;
    case 'GLASS': 
      sorterPosition = '01'; 
      console.log('   🟢 Rotating to GLASS crusher (position 01)');
      break;
  }
  
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: sorterPosition }
  });
  
  console.log('   ⏳ Basket rotating and dumping...');
  await delay(SYSTEM_CONFIG.applet.timeouts.stepperRotate);
  
  console.log('✅ Bottle dumped into crusher!\n');
  await delay(1000);
}

// ======= STEP 6: BELT REVERSE =======
async function beltReverseToStart() {
  console.log('▶️ Step 6: Belt returning to start position...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.reverse
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.beltReverse);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Belt at start\n');
  await delay(500);
}

// ======= STEP 7: COMPACTOR =======
async function compactorCrush() {
  console.log('▶️ Step 7: Compactor crushing...');
  
  // Forward crush
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.forward
  });
  
  console.log(`   ⏳ Crushing for ${SYSTEM_CONFIG.applet.timeouts.compactorForward}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.compactorForward);
  
  // Reverse 3 seconds (per flowchart)
  console.log('   ⏪ Reversing compactor...');
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.reverse
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.compactorReverse);
  
  // Stop
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.stop
  });
  
  console.log('✅ Compaction complete\n');
  await delay(500);
}

// ======= STEP 8: RESET STEPPER =======
async function resetStepperToHome() {
  console.log('▶️ Step 8: Resetting stepper motor to home...');
  
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: '01' } // Home position
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.stepperReset);
  
  console.log('✅ Stepper at home\n');
  await delay(500);
}

// ======= FULL CYCLE - MATCHES FLOWCHART =======
async function executeFullCycle() {
  console.log('\n========================================');
  console.log('🚀 STARTING CYCLE - FLOWCHART SEQUENCE');
  console.log('========================================');
  console.log(`📍 Material: ${latestAIResult.materialType}`);
  console.log(`⚖️ Weight: ${latestWeight.weight}g`);
  console.log('========================================\n');
  
  try {
    // STEP 0: Gate Open
    console.log('▶️ Step 0: Opening gate...');
    await executeCommand({ action: 'openGate' });
    await delay(1000);
    console.log('✅ Gate opened\n');
    
    // STEP 1: Belt Forward to Weight
    await beltForwardToWeight();
    
    // STEP 2 & 3: Weight & AI Detection (already done)
    console.log('✅ Step 2: Weight detected:', latestWeight.weight, 'g');
    console.log('✅ Step 3: AI detected:', latestAIResult.materialType, '\n');
    await delay(500);
    
    // STEP 4: PUSHER - Push bottle FROM belt TO white basket
    await pushBottleToBasket();
    
    // STEP 5: STEPPER MOTOR - Rotate basket to dump into crusher
    await stepperDumpIntoCrusher(latestAIResult.materialType);
    
    // STEP 6: Belt Reverse
    await beltReverseToStart();
    
    // STEP 7: Compactor
    await compactorCrush();
    
    // STEP 8: Reset Stepper
    await resetStepperToHome();
    
    // STEP 9: Gate Close
    console.log('▶️ Step 9: Closing gate...');
    await executeCommand({ action: 'closeGate' });
    await delay(1000);
    console.log('✅ Gate closed\n');
    
    console.log('========================================');
    console.log('✅ CYCLE COMPLETE - BOTTLE IN CRUSHER!');
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
    
    // Emergency stop
    console.log('🛑 Emergency stop...');
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.belt.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.pusher.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.compactor.stop });
    await resetStepperToHome();
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
    apiPayload = { moduleId: currentModuleId, type: params?.position || '01', deviceType };
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
console.log('🚀 RVM AGENT v7.0 - FINAL VERSION');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('✅ CORRECT SEQUENCE (per flowchart):');
console.log('   0. Gate Open');
console.log('   1. Belt Forward → Weight position');
console.log('   2. Weight Detection ✅');
console.log('   3. AI Detection ✅');
console.log('   4. Motor 03 PUSHES → Bottle to basket 💪');
console.log('   5. Stepper ROTATES → Dumps into crusher 🔄');
console.log('   6. Belt Reverse → Back to start');
console.log('   7. Compactor → Crush + Reverse');
console.log('   8. Reset Stepper → Home');
console.log('   9. Gate Close');
console.log('========================================');
console.log('🔧 KEY FIX:');
console.log('   ✅ NO DRUM OPERATIONS (removed)');
console.log('   ✅ Motor 03 Type 03 ADDED (push to basket)');
console.log('   ✅ Matches flowchart exactly!');
console.log('========================================\n');