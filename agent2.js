// RVM Agent v7.1 - FINAL BASED ON ACTUAL CONFIGURATION
// Matches actual machine settings: Step Motor 2000 (rotate), 20000 (init)
// NO DRUM - Belt forward increased for better positioning
// Save as: agent-v7.1-final-config.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= SYSTEM CONFIGURATION (FROM ACTUAL MACHINE) =======
const SYSTEM_CONFIG = {
  // Belt commands
  belt: {
    forward: { motorId: "02", type: "02" },      // Belt forward
    reverse: { motorId: "02", type: "01" },      // Belt reverse
    stop: { motorId: "02", type: "00" }          // Belt stop
  },
  
  // Pusher command (Motor 03 - pushes bottle to white basket)
  pusher: {
    toRoller: { motorId: "03", type: "03" },     // Push to roller/basket
    stop: { motorId: "03", type: "00" }          // Stop pusher
  },
  
  // Compactor commands (Plastic compactor from config screen)
  compactor: {
    start: { motorId: "04", type: "01" },        // Plastic compactor start
    stop: { motorId: "04", type: "00" }          // Plastic compactor stop
  },
  
  // Stepper Motor (from config: 2000 for rotate, 20000 for init)
  stepper: {
    rotate: '2000',      // Step Motor Move from config screen
    initialize: '20000'  // Target 0x00000 = 20000 decimal (initialization)
  },
  
  // Timing configurations
  applet: {
    weightCoefficients: { 1: 988, 2: 942, 3: 942, 4: 942 },
    timeouts: { 
      beltForward: 5000,         // INCREASED - belt moves more towards machine
      pusherToRoller: 5000,      // Pusher pushes bottle to white basket
      stepperRotate: 3000,       // Stepper motor rotation time
      stepperInitialize: 4000,   // Stepper initialization time (20000 steps takes longer)
      beltReverse: 8000,         // Belt reverse to start
      compactor: 6000            // Compactor crush time
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
  console.log('▶️ Step 1: Belt moving bottle towards machine (to weight position)...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.forward
  });
  
  console.log(`   ⏳ Moving for ${SYSTEM_CONFIG.applet.timeouts.beltForward}ms (increased for better positioning)...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.beltForward);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Bottle at weight position\n');
  await delay(500);
}

// ======= STEP 2 & 3: WEIGHT + AI DETECTION (automatic) =======

// ======= STEP 4: PUSHER - PUSH TO ROLLER (WHITE BASKET) =======
async function pushBottleToRoller() {
  console.log('▶️ Step 4: Transfer forward to roller (Motor 03 pushes bottle to white basket)...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.pusher.toRoller
  });
  
  console.log(`   ⏳ Pushing for ${SYSTEM_CONFIG.applet.timeouts.pusherToRoller}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.pusherToRoller);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.pusher.stop
  });
  
  console.log('✅ Bottle on white basket (roller)!\n');
  await delay(1000);
}

// ======= STEP 5: STEPPER MOTOR - ROTATE TO DUMP =======
async function stepperRotateAndDump(materialType) {
  console.log('▶️ Step 5: Stepping motor rolling the roller (2000 steps)...');
  
  let sorterPosition = SYSTEM_CONFIG.stepper.rotate; // Use 2000 from config
  
  switch (materialType) {
    case 'PLASTIC_BOTTLE': 
      console.log('   🔵 Rotating to PLASTIC bin (2000 steps)');
      break;
    case 'METAL_CAN': 
      console.log('   🟡 Rotating to METAL bin (2000 steps)');
      break;
    case 'GLASS': 
      console.log('   🟢 Rotating to GLASS bin (2000 steps)');
      break;
  }
  
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: sorterPosition }
  });
  
  console.log('   ⏳ Stepper rotating (dumping bottle)...');
  await delay(SYSTEM_CONFIG.applet.timeouts.stepperRotate);
  
  console.log('✅ Bottle dumped into bin!\n');
  await delay(1000);
}

// ======= STEP 6: COMPACTOR =======
async function compactorCrush() {
  console.log('▶️ Step 6: Plastic compactor starting...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.start
  });
  
  console.log(`   ⏳ Compacting for ${SYSTEM_CONFIG.applet.timeouts.compactor}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.compactor);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.stop
  });
  
  console.log('✅ Compaction complete\n');
  await delay(500);
}

// ======= STEP 7: BELT REVERSE =======
async function beltReverseToStart() {
  console.log('▶️ Step 7: Belt returning to start position...');
  
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

// ======= STEP 8: RESET STEPPER (INITIALIZE) =======
async function stepperInitialize() {
  console.log('▶️ Step 8: Initializing stepper motor (20000 steps to home)...');
  
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: SYSTEM_CONFIG.stepper.initialize } // 20000 from config
  });
  
  console.log('   ⏳ Initializing (this takes longer - 20000 steps)...');
  await delay(SYSTEM_CONFIG.applet.timeouts.stepperInitialize);
  
  console.log('✅ Stepper initialized (home position)\n');
  await delay(500);
}

// ======= FULL CYCLE - BASED ON ACTUAL CONFIG =======
async function executeFullCycle() {
  console.log('\n========================================');
  console.log('🚀 STARTING CYCLE - ACTUAL CONFIG');
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
    
    // STEP 1: Belt Forward to Weight (INCREASED - moves more towards machine)
    await beltForwardToWeight();
    
    // STEP 2 & 3: Weight & AI Detection (already done)
    console.log('✅ Step 2: Weight detected:', latestWeight.weight, 'g');
    console.log('✅ Step 3: AI detected:', latestAIResult.materialType, '\n');
    await delay(500);
    
    // STEP 4: Push bottle to Roller (Motor 03 - white basket)
    await pushBottleToRoller();
    
    // STEP 5: Stepper Motor Rotate (2000 steps from config)
    await stepperRotateAndDump(latestAIResult.materialType);
    
    // STEP 6: Compactor
    await compactorCrush();
    
    // STEP 7: Belt Reverse
    await beltReverseToStart();
    
    // STEP 8: Stepper Initialize (20000 steps from config)
    await stepperInitialize();
    
    // STEP 9: Gate Close
    console.log('▶️ Step 9: Closing gate...');
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
    
    // Emergency stop
    console.log('🛑 Emergency stop...');
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.belt.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.pusher.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.compactor.stop });
    await stepperInitialize();
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
    apiPayload = { 
      moduleId: currentModuleId, 
      type: params?.position || SYSTEM_CONFIG.stepper.initialize, 
      deviceType 
    };
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
console.log('🚀 RVM AGENT v7.1 - ACTUAL CONFIG');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('✅ BASED ON ACTUAL MACHINE SETTINGS:');
console.log('   • Stepper: 2000 steps (rotate/dump)');
console.log('   • Stepper: 20000 steps (initialize)');
console.log('   • NO DRUM operations (removed)');
console.log('   • Belt forward: 5000ms (increased)');
console.log('========================================');
console.log('📋 SEQUENCE:');
console.log('   0. Gate Open');
console.log('   1. Belt Forward → Weight (5s)');
console.log('   2-3. Weight + AI Detection');
console.log('   4. Motor 03 → Push to roller');
console.log('   5. Stepper → Rotate 2000 steps');
console.log('   6. Compactor → Crush');
console.log('   7. Belt Reverse → Start');
console.log('   8. Stepper → Initialize 20000 steps');
console.log('   9. Gate Close');
console.log('========================================\n');