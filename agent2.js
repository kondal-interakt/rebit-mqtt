// RVM Agent v7.2 - FIXED STEPPER MOTOR POSITIONS
// CRITICAL FIX: Using correct position codes (00-03) not step counts
// Belt forward increased to 8000ms
// Save as: agent-v7.2-fixed-stepper.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= SYSTEM CONFIGURATION =======
const SYSTEM_CONFIG = {
  // Belt commands
  belt: {
    forward: { motorId: "02", type: "02" },
    reverse: { motorId: "02", type: "01" },
    stop: { motorId: "02", type: "00" }
  },
  
  // Pusher command (Motor 03)
  pusher: {
    toRoller: { motorId: "03", type: "03" },
    stop: { motorId: "03", type: "00" }
  },
  
  // Compactor commands
  compactor: {
    start: { motorId: "04", type: "01" },
    stop: { motorId: "04", type: "00" }
  },
  
  // STEPPER MOTOR POSITION CODES (from documentation section 13)
  // CRITICAL: Stepper motor has its own module ID: 0F (section 10)
  stepper: {
    moduleId: '0F',  // Stepper motor module (NOT the main module!)
    positions: {
      initialization: '00',   // Full reset
      home: '01',            // Return to origin (flat basket)
      metalCan: '02',        // Tilt for metal can
      plasticBottle: '03'    // Tilt for plastic bottle
    }
  },
  
  // Timing configurations
  applet: {
    weightCoefficients: { 1: 988, 2: 942, 3: 942, 4: 942 },
    timeouts: { 
      beltForward: 8000,         // INCREASED to 8000ms as requested
      pusherToRoller: 5000,      
      stepperRotate: 4000,       // Time for stepper to complete rotation
      beltReverse: 8000,         
      compactor: 6000            
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
  
  console.log(`   ⏳ Moving for ${SYSTEM_CONFIG.applet.timeouts.beltForward}ms (INCREASED to 8000ms)...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.beltForward);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Bottle at weight position\n');
  await delay(500);
}

// ======= STEP 4: PUSHER - PUSH TO ROLLER =======
async function pushBottleToRoller() {
  console.log('▶️ Step 4: Transfer forward to roller (Motor 03)...');
  
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
  
  console.log('✅ Bottle on white basket!\n');
  await delay(1000);
}

// ======= STEP 5: STEPPER MOTOR - ROTATE TO DUMP (FIXED!) =======
async function stepperRotateAndDump(materialType) {
  console.log('▶️ Step 5: Stepping motor rotating to dump bottle...');
  
  // Use CORRECT position codes from documentation
  let positionCode = SYSTEM_CONFIG.stepper.positions.plasticBottle; // Default '03'
  
  switch (materialType) {
    case 'PLASTIC_BOTTLE': 
      positionCode = SYSTEM_CONFIG.stepper.positions.plasticBottle; // '03'
      console.log('   🔵 PLASTIC: Using position code 03');
      break;
    case 'METAL_CAN': 
      positionCode = SYSTEM_CONFIG.stepper.positions.metalCan; // '02'
      console.log('   🟡 METAL: Using position code 02');
      break;
    case 'GLASS': 
      positionCode = SYSTEM_CONFIG.stepper.positions.plasticBottle; // '03' (fallback)
      console.log('   🟢 GLASS: Using position code 03');
      break;
  }
  
  console.log(`   🔧 Sending stepper command: position=${positionCode}`);
  
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: positionCode }
  });
  
  console.log('   ⏳ Stepper rotating (internal 2000 steps)...');
  await delay(SYSTEM_CONFIG.applet.timeouts.stepperRotate);
  
  console.log('✅ Stepper rotated! Bottle should be dumped!\n');
  await delay(1000);
}

// ======= STEP 6: COMPACTOR =======
async function compactorCrush() {
  console.log('▶️ Step 6: Compactor starting...');
  
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
  console.log('▶️ Step 7: Belt returning to start...');
  
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

// ======= STEP 8: RESET STEPPER TO HOME (FIXED!) =======
async function stepperResetToHome() {
  console.log('▶️ Step 8: Resetting stepper to home position...');
  
  // Use position code '01' for home (not '20000')
  const homePosition = SYSTEM_CONFIG.stepper.positions.home; // '01'
  
  console.log(`   🔧 Sending stepper reset: position=${homePosition}`);
  
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: homePosition }
  });
  
  console.log('   ⏳ Resetting to home (internal 20000 steps)...');
  await delay(SYSTEM_CONFIG.applet.timeouts.stepperRotate);
  
  console.log('✅ Stepper at home (flat basket)\n');
  await delay(500);
}

// ======= FULL CYCLE =======
async function executeFullCycle() {
  console.log('\n========================================');
  console.log('🚀 STARTING CYCLE - FIXED STEPPER');
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
    
    // STEP 1: Belt Forward (8000ms)
    await beltForwardToWeight();
    
    // STEP 2 & 3: Weight & AI (already done)
    console.log('✅ Step 2: Weight:', latestWeight.weight, 'g');
    console.log('✅ Step 3: AI:', latestAIResult.materialType, '\n');
    await delay(500);
    
    // STEP 4: Push to Roller
    await pushBottleToRoller();
    
    // STEP 5: Stepper Rotate (FIXED - using position codes!)
    await stepperRotateAndDump(latestAIResult.materialType);
    
    // STEP 6: Compactor
    await compactorCrush();
    
    // STEP 7: Belt Reverse
    await beltReverseToStart();
    
    // STEP 8: Stepper Reset (FIXED - using position code!)
    await stepperResetToHome();
    
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
    await stepperResetToHome();
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
    
    // CRITICAL FIX: Stepper motor has its own module ID: 0F (not currentModuleId!)
    const stepperModuleId = SYSTEM_CONFIG.stepper.moduleId; // '0F'
    const positionCode = params?.position || '01';
    
    console.log(`   🔧 API Call: stepMotorSelect with moduleId="${stepperModuleId}", position="${positionCode}"`);
    
    apiPayload = { 
      moduleId: stepperModuleId,  // FIXED: Use 0F for stepper motor
      type: positionCode,
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
    console.log(`   📡 Sending to ${apiUrl.split('/').pop()}: ${JSON.stringify(apiPayload)}`);
    
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
console.log('🚀 RVM AGENT v7.2 - FIXED STEPPER!');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🔧 CRITICAL FIX:');
console.log('   ❌ OLD: moduleId="09" (WRONG!)');
console.log('   ✅ NEW: moduleId="0F" (Stepper Module!)');
console.log('   • Stepper has its own module: 0F');
console.log('   • Position 03 = Plastic dump');
console.log('   • Position 02 = Metal dump');
console.log('   • Position 01 = Home');
console.log('========================================');
console.log('⚙️ UPDATED SETTINGS:');
console.log('   • Belt forward: 8000ms (increased)');
console.log('   • Stepper Module ID: 0F');
console.log('========================================\n')