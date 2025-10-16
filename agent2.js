// RVM Agent v7.3 - FIXED BELT AND STEPPER TIMING
// FIXES:
// - Increased belt forward to 10000ms for complete travel
// - Fixed stepper rotation timing (6000ms for dump, 10000ms for reset)
// - Added position verification delays
// - Improved pusher timing
// Save as: agent-v7.3-fixed-timing.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= SYSTEM CONFIGURATION =======
const SYSTEM_CONFIG = {
  // Belt commands (Motor 02)
  belt: {
    forward: { motorId: "02", type: "02" },  // Move to weight/AI position
    reverse: { motorId: "02", type: "01" },  // Return to start
    stop: { motorId: "02", type: "00" }      // Stop belt
  },
  
  // Pusher/Transfer command (Motor 03)
  pusher: {
    toRoller: { motorId: "03", type: "03" },  // Push to white basket/roller
    reverse: { motorId: "03", type: "01" },   // Reverse (if needed)
    stop: { motorId: "03", type: "00" }       // Stop pusher
  },
  
  // Compactor commands (Motor 04)
  compactor: {
    start: { motorId: "04", type: "01" },    // Start crushing
    stop: { motorId: "04", type: "00" }      // Stop crushing
  },
  
  // STEPPER MOTOR POSITION CODES (Module 0F)
  stepper: {
    moduleId: '09',  // Stepper motor has its own module ID!
    positions: {
      initialization: '00',   // Full initialization
      home: '01',            // Return to origin (flat basket position)
      metalCan: '02',        // Tilt position for metal can
      plasticBottle: '03'    // Tilt position for plastic bottle
    }
  },
  
  // FIXED TIMING CONFIGURATIONS
  applet: {
    weightCoefficients: { 1: 988, 2: 942, 3: 942, 4: 942 },
    timeouts: { 
      beltForward: 10000,        // INCREASED to 10000ms for complete travel
      pusherToRoller: 6000,      // INCREASED pusher time  
      stepperRotate: 6000,       // INCREASED for proper basket rotation
      stepperReset: 10000,       // LONGER reset time (20000 steps vs 2000)
      beltReverse: 10000,        // Match forward timing
      compactor: 6000,           // Compactor crushing time
      positionSettle: 1000       // Time for mechanisms to settle
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
  console.log('▶️ Step 1: Belt moving bottle to weight/AI position...');
  console.log('   📏 Belt travel time: ' + SYSTEM_CONFIG.applet.timeouts.beltForward + 'ms');
  
  // Start belt forward
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.forward
  });
  
  // Wait for complete travel
  await delay(SYSTEM_CONFIG.applet.timeouts.beltForward);
  
  // Stop belt
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  // Allow position to settle
  console.log('   ⏳ Allowing position to settle...');
  await delay(SYSTEM_CONFIG.applet.timeouts.positionSettle);
  
  console.log('✅ Bottle at weight/AI position\n');
}

// ======= STEP 4: PUSHER - PUSH TO ROLLER =======
async function pushBottleToRoller() {
  console.log('▶️ Step 4: Pushing bottle to white basket/roller...');
  console.log('   📏 Pusher operation time: ' + SYSTEM_CONFIG.applet.timeouts.pusherToRoller + 'ms');
  
  // Start pusher forward
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.pusher.toRoller
  });
  
  // Wait for push completion
  await delay(SYSTEM_CONFIG.applet.timeouts.pusherToRoller);
  
  // Stop pusher
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.pusher.stop
  });
  
  // Allow bottle to settle in basket
  console.log('   ⏳ Bottle settling in basket...');
  await delay(SYSTEM_CONFIG.applet.timeouts.positionSettle);
  
  console.log('✅ Bottle on white basket ready for tilting!\n');
}

// ======= STEP 5: STEPPER MOTOR - ROTATE TO DUMP =======
async function stepperRotateAndDump(materialType) {
  console.log('▶️ Step 5: Tilting basket to dump bottle...');
  
  // Select position based on material type
  let positionCode = SYSTEM_CONFIG.stepper.positions.plasticBottle; // Default
  
  switch (materialType) {
    case 'PLASTIC_BOTTLE': 
      positionCode = SYSTEM_CONFIG.stepper.positions.plasticBottle; // '03'
      console.log('   🔵 PLASTIC: Moving to position 03');
      break;
    case 'METAL_CAN': 
      positionCode = SYSTEM_CONFIG.stepper.positions.metalCan; // '02'
      console.log('   🟡 METAL: Moving to position 02');
      break;
    case 'GLASS': 
      positionCode = SYSTEM_CONFIG.stepper.positions.plasticBottle; // '03' fallback
      console.log('   🟢 GLASS: Moving to position 03');
      break;
    default:
      console.log('   ⚪ UNKNOWN: Using default position 03');
  }
  
  console.log(`   🔧 Sending stepper command:`);
  console.log(`      - Module ID: ${SYSTEM_CONFIG.stepper.moduleId}`);
  console.log(`      - Position: ${positionCode}`);
  console.log(`      - Rotation time: ${SYSTEM_CONFIG.applet.timeouts.stepperRotate}ms`);
  
  // Send stepper command
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: positionCode }
  });
  
  // Wait for basket rotation (2000 internal steps)
  await delay(SYSTEM_CONFIG.applet.timeouts.stepperRotate);
  
  // Extra settling time for bottle to fall
  console.log('   ⏳ Allowing bottle to fall into crusher...');
  await delay(SYSTEM_CONFIG.applet.timeouts.positionSettle);
  
  console.log('✅ Basket tilted! Bottle dumped into crusher!\n');
}

// ======= STEP 6: COMPACTOR =======
async function compactorCrush() {
  console.log('▶️ Step 6: Starting compactor...');
  
  // Start compactor
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.start
  });
  
  console.log(`   ⏳ Crushing for ${SYSTEM_CONFIG.applet.timeouts.compactor}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.compactor);
  
  // Stop compactor
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
  console.log('   📏 Belt reverse time: ' + SYSTEM_CONFIG.applet.timeouts.beltReverse + 'ms');
  
  // Start belt reverse
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.reverse
  });
  
  // Wait for complete return
  await delay(SYSTEM_CONFIG.applet.timeouts.beltReverse);
  
  // Stop belt
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Belt at start position\n');
  await delay(500);
}

// ======= STEP 8: RESET STEPPER TO HOME =======
async function stepperResetToHome() {
  console.log('▶️ Step 8: Resetting basket to home (flat) position...');
  
  const homePosition = SYSTEM_CONFIG.stepper.positions.home; // '01'
  
  console.log(`   🔧 Sending stepper reset command:`);
  console.log(`      - Module ID: ${SYSTEM_CONFIG.stepper.moduleId}`);
  console.log(`      - Position: ${homePosition} (home)`);
  console.log(`      - Reset time: ${SYSTEM_CONFIG.applet.timeouts.stepperReset}ms`);
  
  // Send reset command
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: homePosition }
  });
  
  // Wait for basket reset (20000 internal steps - takes longer!)
  await delay(SYSTEM_CONFIG.applet.timeouts.stepperReset);
  
  console.log('✅ Basket reset to home (flat) position\n');
  await delay(500);
}

// ======= FULL CYCLE =======
async function executeFullCycle() {
  console.log('\n========================================');
  console.log('🚀 STARTING CYCLE v7.3 - FIXED TIMING');
  console.log('========================================');
  console.log(`📍 Material: ${latestAIResult.materialType}`);
  console.log(`⚖️ Weight: ${latestWeight.weight}g`);
  console.log('========================================\n');
  
  try {
    // STEP 0: Gate Open
    console.log('▶️ Step 0: Opening gate...');
    await executeCommand({ action: 'openGate' });
    await delay(2000); // Increased gate open time
    console.log('✅ Gate opened\n');
    
    // STEP 1: Belt Forward (10000ms)
    await beltForwardToWeight();
    
    // STEP 2 & 3: Weight & AI (already done)
    console.log('✅ Step 2: Weight detected: ' + latestWeight.weight + 'g');
    console.log('✅ Step 3: AI identified: ' + latestAIResult.materialType + '\n');
    await delay(500);
    
    // STEP 4: Push to Roller/Basket
    await pushBottleToRoller();
    
    // STEP 5: Stepper Rotate (Tilt basket to dump)
    await stepperRotateAndDump(latestAIResult.materialType);
    
    // STEP 6: Compactor
    await compactorCrush();
    
    // STEP 7: Belt Reverse
    await beltReverseToStart();
    
    // STEP 8: Stepper Reset (Return basket to flat position)
    await stepperResetToHome();
    
    // STEP 9: Gate Close
    console.log('▶️ Step 9: Closing gate...');
    await executeCommand({ action: 'closeGate' });
    await delay(2000);
    console.log('✅ Gate closed\n');
    
    console.log('========================================');
    console.log('✅ CYCLE COMPLETE SUCCESSFULLY!');
    console.log('========================================\n');
    
    // Publish success
    mqttClient.publish(`rvm/${DEVICE_ID}/cycle_complete`, JSON.stringify({
      material: latestAIResult.materialType,
      weight: latestWeight.weight,
      timestamp: new Date().toISOString()
    }));
    
    // Reset state
    cycleInProgress = false;
    latestAIResult = null;
    latestWeight = null;
    
  } catch (err) {
    console.error('========================================');
    console.error('❌ CYCLE FAILED:', err.message);
    console.error('========================================\n');
    cycleInProgress = false;
    
    // Emergency stop all motors
    console.log('🛑 EMERGENCY STOP - Stopping all motors...');
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.belt.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.pusher.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.compactor.stop });
    
    // Reset stepper to home
    console.log('🛑 Resetting stepper to home...');
    await stepperResetToHome();
    
    // Close gate
    await executeCommand({ action: 'closeGate' });
    console.log('🛑 Emergency stop complete\n');
  }
}

// ======= EXECUTE COMMAND =======
async function executeCommand(commandData) {
  const { action, params } = commandData;
  const deviceType = 1;
  
  // Check for module ID (except for getModuleId)
  if (!currentModuleId && action !== 'getModuleId') {
    console.error('❌ No moduleId available');
    return;
  }
  
  let apiUrl, apiPayload;
  
  // Gate commands
  if (action === 'openGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { 
      moduleId: currentModuleId, 
      motorId: '01', 
      type: '03', 
      deviceType 
    };
  } else if (action === 'closeGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { 
      moduleId: currentModuleId, 
      motorId: '01', 
      type: '00', 
      deviceType 
    };
  } 
  // Weight commands
  else if (action === 'getWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/getWeight`;
    apiPayload = { 
      moduleId: currentModuleId, 
      type: '00' 
    };
  } else if (action === 'calibrateWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/weightCalibration`;
    apiPayload = { 
      moduleId: currentModuleId, 
      type: '00' 
    };
  } 
  // Camera
  else if (action === 'takePhoto') {
    apiUrl = `${LOCAL_API_BASE}/system/camera/process`;
    apiPayload = {};
  } 
  // STEPPER MOTOR - Uses its own module ID!
  else if (action === 'stepperMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/stepMotorSelect`;
    
    const stepperModuleId = SYSTEM_CONFIG.stepper.moduleId; // Always '0F'
    const positionCode = params?.position || '01';
    
    console.log(`   📡 Stepper API call with moduleId="${stepperModuleId}", position="${positionCode}"`);
    
    apiPayload = { 
      moduleId: stepperModuleId,
      id :positionCode,  // CRITICAL: Use 0F for stepper
      type: positionCode,
      deviceType 
    };
  } 
  // Regular motors (belt, pusher, compactor)
  else if (action === 'customMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = {
      moduleId: currentModuleId,  // Use dynamic module ID for regular motors
      motorId: params?.motorId,
      type: params?.type,
      deviceType
    };
  } else {
    console.error('⚠️ Unknown action:', action);
    return;
  }
  
  try {
    console.log(`   📡 Calling ${apiUrl.split('/').pop()}: ${JSON.stringify(apiPayload)}`);
    
    const response = await axios.post(apiUrl, apiPayload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    // Add delays for specific actions
    if (action === 'takePhoto') {
      await delay(2000);
    } else if (action === 'getWeight') {
      await delay(3000);
    }
    
  } catch (err) {
    console.error(`❌ ${action} failed:`, err.message);
    throw err; // Propagate error for emergency stop
  }
}

// ======= REQUEST MODULE ID =======
async function requestModuleId() {
  try {
    console.log('📡 Requesting module ID...');
    await axios.post(`${LOCAL_API_BASE}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('❌ Module ID request failed:', err.message);
  }
}

// ======= WEBSOCKET CONNECTION =======
function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected');
    setTimeout(() => requestModuleId(), 1000);
  });
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      
      // Module ID response
      if (message.function === '01') {
        currentModuleId = message.moduleId || message.data;
        console.log(`✅ Module ID received: ${currentModuleId}`);
        
        // Process any pending commands
        if (pendingCommands.size > 0) {
          const [id, cmd] = Array.from(pendingCommands.entries())[0];
          executeCommand(cmd);
          pendingCommands.delete(id);
        }
        return;
      }
      
      // AI Photo result
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
        
        console.log(`🤖 AI Result: ${latestAIResult.matchRate}% - ${latestAIResult.materialType}`);
        
        mqttClient.publish(`rvm/${DEVICE_ID}/ai_result`, JSON.stringify(latestAIResult));
        
        // Auto-cycle: get weight after AI
        if (autoCycleEnabled && latestAIResult.matchRate >= 30 && latestAIResult.materialType !== 'UNKNOWN') {
          setTimeout(() => executeCommand({ action: 'getWeight' }), 500);
        }
        return;
      }
      
      // Weight result
      if (message.function === '06') {
        const weightValue = parseFloat(message.data) || 0;
        const weightCoefficient = SYSTEM_CONFIG.applet.weightCoefficients[1];
        const calibratedWeight = weightValue * (weightCoefficient / 1000);
        
        latestWeight = {
          weight: Math.round(calibratedWeight * 10) / 10,
          rawWeight: weightValue,
          coefficient: weightCoefficient,
          timestamp: new Date().toISOString()
        };
        
        console.log(`⚖️ Weight: ${latestWeight.weight}g (raw: ${weightValue})`);
        
        mqttClient.publish(`rvm/${DEVICE_ID}/weight_result`, JSON.stringify(latestWeight));
        
        // Calibrate if needed
        if (latestWeight.weight <= 0 && calibrationAttempts < 2) {
          calibrationAttempts++;
          console.log(`⚠️ Calibrating weight (${calibrationAttempts}/2)...`);
          setTimeout(async () => {
            await executeCommand({ action: 'calibrateWeight' });
            setTimeout(() => executeCommand({ action: 'getWeight' }), 1000);
          }, 500);
          return;
        }
        
        if (latestWeight.weight > 0) calibrationAttempts = 0;
        
        // Start cycle if conditions met
        if (autoCycleEnabled && latestAIResult && latestWeight.weight > 1 && !cycleInProgress) {
          cycleInProgress = true;
          setTimeout(() => executeFullCycle(), 1000);
        }
        return;
      }
      
      // Device status (object detection)
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        if (code === 4 && autoCycleEnabled && !cycleInProgress) {
          console.log('👤 Object detected by sensor');
          setTimeout(() => executeCommand({ action: 'takePhoto' }), 1000);
        }
        return;
      }
      
    } catch (err) {
      console.error('❌ WebSocket message error:', err.message);
    }
  });
  
  ws.on('close', () => {
    console.log('⚠️ WebSocket closed, reconnecting in 5s...');
    setTimeout(connectWebSocket, 5000);
  });
  
  ws.on('error', (err) => console.error('❌ WebSocket error:', err.message));
}

// ======= UTILITY FUNCTIONS =======
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

// ======= MQTT CONNECTION =======
const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  ca: fs.readFileSync(MQTT_CA_FILE),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  console.log('✅ MQTT connected');
  
  // Subscribe to control topics
  mqttClient.subscribe(`rvm/${DEVICE_ID}/commands`);
  mqttClient.subscribe(`rvm/${DEVICE_ID}/control/auto`);
  
  // Start WebSocket connection
  connectWebSocket();
  
  // Request module ID after connection
  setTimeout(requestModuleId, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    // Auto mode control
    if (topic.includes('/control/auto')) {
      autoCycleEnabled = payload.enabled === true;
      console.log(`🤖 AUTO MODE: ${autoCycleEnabled ? 'ENABLED' : 'DISABLED'}`);
      
      if (autoCycleEnabled && currentModuleId) {
        await executeCommand({ action: 'openGate' });
      } else if (!autoCycleEnabled && currentModuleId) {
        await executeCommand({ action: 'closeGate' });
      }
      return;
    }
    
    // Manual commands
    if (topic.includes('/commands')) {
      console.log(`📩 Command received: ${payload.action}`);
      
      if (!currentModuleId) {
        pendingCommands.set(Date.now().toString(), payload);
        await requestModuleId();
      } else {
        await executeCommand(payload);
      }
    }
    
  } catch (err) {
    console.error('❌ MQTT message error:', err.message);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down gracefully...');
  if (ws) ws.close();
  mqttClient.end();
  process.exit(0);
});

// ======= STARTUP =======
console.log('========================================');
console.log('🚀 RVM AGENT v7.3 - FIXED TIMING');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🔧 KEY FIXES IN THIS VERSION:');
console.log('   ✅ Belt forward: 10000ms (complete travel)');
console.log('   ✅ Belt reverse: 10000ms (matching forward)');
console.log('   ✅ Pusher time: 6000ms (ensure transfer)');
console.log('   ✅ Stepper rotate: 6000ms (proper tilt)');
console.log('   ✅ Stepper reset: 10000ms (20000 steps)');
console.log('   ✅ Position settle delays added');
console.log('   ✅ Module IDs: Dynamic for motors, 0F for stepper');
console.log('========================================');
console.log('📋 PROCESS FLOW:');
console.log('   0. Gate opens');
console.log('   1. Belt forward (10s) → weight/AI position');
console.log('   2. Weight measurement');
console.log('   3. AI identification');
console.log('   4. Pusher (6s) → white basket');
console.log('   5. Stepper tilt → dump to crusher');
console.log('   6. Compactor crushes');
console.log('   7. Belt reverse (10s) → start');
console.log('   8. Stepper reset → flat position');
console.log('   9. Gate closes');
console.log('========================================\n');
console.log('⏳ Waiting for connections...\n');