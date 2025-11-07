// agent.js - Updated for Member & Guest Support with Multiple Items
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  device: {
    id: 'RVM-3101'  // Can be read from config file or environment variable
  },
  
  backend: {
    url: 'https://rebit-api.ceewen.xyz',
    timeout: 10000
  },
  
  local: {
    baseUrl: 'http://localhost:8081',
    wsUrl: 'ws://localhost:8081/websocket/qazwsx1234',
    timeout: 10000
  },
  
  mqtt: {
    brokerUrl: 'mqtts://mqtt.ceewen.xyz:8883',
    username: 'mqttuser',
    password: 'mqttUser@2025',
    caFile: 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle',
    topics: {
      commands: 'rvm/RVM-3101/commands',
      autoControl: 'rvm/RVM-3101/control/auto',
      cycleComplete: 'rvm/RVM-3101/cycle/complete',
      aiResult: 'rvm/RVM-3101/ai/result',
      weightResult: 'rvm/RVM-3101/weight/result',
      status: 'rvm/RVM-3101/status',
      qrScan: 'rvm/RVM-3101/qr/scanned',        // Member QR validated
      guestStart: 'rvm/RVM-3101/guest/start',   // Guest session started
      screenState: 'rvm/RVM-3101/screen/state'  // Monitor screen updates
    }
  },
  
  motors: {
    belt: {
      toWeight: { motorId: "02", type: "02" },
      toStepper: { motorId: "02", type: "03" },
      reverse: { motorId: "02", type: "01" },
      stop: { motorId: "02", type: "00" }
    },
    compactor: {
      start: { motorId: "04", type: "01" },
      stop: { motorId: "04", type: "00" }
    },
    stepper: {
      moduleId: '09',
      positions: { home: '01', metalCan: '02', plasticBottle: '03' }
    }
  },
  
  detection: {
    METAL_CAN: 0.22,
    PLASTIC_BOTTLE: 0.30,
    GLASS: 0.25,
    retryDelay: 2000,        // 2 seconds between retries
    maxRetries: 3            // Maximum retry attempts
  },
  
  timing: {
    beltToWeight: 3000,
    beltToStepper: 4000,
    beltReverse: 5000,
    stepperRotate: 4000,
    stepperReset: 6000,
    compactor: 24000,
    positionSettle: 500,
    gateOperation: 1000,
    autoPhotoDelay: 5000
  },
  
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  }
};

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
  moduleId: null,
  aiResult: null,
  weight: null,
  autoCycleEnabled: false,
  cycleInProgress: false,
  calibrationAttempts: 0,
  ws: null,
  
  // Session tracking
  sessionId: null,
  sessionCode: null,
  currentUserId: null,
  currentUserData: null,
  isMember: false,        // Track if member or guest
  isGuestSession: false,  // Track if guest session
  
  // Multi-item tracking
  itemsProcessed: 0,
  sessionStartTime: null,
  
  autoPhotoTimer: null,
  
  // Detection retry tracking
  detectionRetries: 0,
  maxDetectionRetries: 3,
  awaitingDetection: false
};

// ============================================
// UTILITY FUNCTIONS
// ============================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  
  let materialType = 'UNKNOWN';
  let threshold = 1.0;
  let hasStrongKeyword = false;
  
  // Check for metal can indicators
  if (className.includes('易拉罐') || className.includes('metal') || 
      className.includes('can') || className.includes('铝')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
    // Strong keyword match if contains specific metal can terms
    hasStrongKeyword = className.includes('易拉罐') || className.includes('铝');
  } 
  // Check for plastic bottle indicators
  else if (className.includes('pet') || className.includes('plastic') || 
           className.includes('瓶') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
    // Strong keyword match if contains PET (common in barcodes/labels)
    hasStrongKeyword = className.includes('pet');
  } 
  // Check for glass indicators
  else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS';
    threshold = CONFIG.detection.GLASS;
    hasStrongKeyword = className.includes('玻璃');
  }
  
  const confidencePercent = Math.round(probability * 100);
  const thresholdPercent = Math.round(threshold * 100);
  
  // If material type detected but confidence too low
  if (materialType !== 'UNKNOWN' && probability < threshold) {
    // Use relaxed threshold if we have strong keyword match
    const relaxedThreshold = threshold * 0.3; // 30% of original threshold
    
    if (hasStrongKeyword && probability >= relaxedThreshold) {
      console.log(`✅ ${materialType} detected via keyword match (${confidencePercent}% confidence, relaxed threshold)`);
      return materialType;
    }
    
    console.log(`⚠️ ${materialType} detected but confidence too low (${confidencePercent}% < ${thresholdPercent}%)`);
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN') {
    console.log(`✅ ${materialType} detected (${confidencePercent}%)`);
  }
  
  return materialType;
}

// ============================================
// HARDWARE CONTROL
// ============================================
async function executeCommand(action, params = {}) {
  const deviceType = 1;
  
  if (!state.moduleId && action !== 'getModuleId') {
    throw new Error('Module ID not available');
  }
  
  let apiUrl, apiPayload;
  
  switch (action) {
    case 'openGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '03', deviceType };
      break;
      
    case 'closeGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '00', deviceType };
      // Log who's closing the gate to help debug
      console.log('⚠️ GATE CLOSING - Stack trace:', new Error().stack);
      break;
      
    case 'getWeight':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/getWeight`;
      apiPayload = { moduleId: state.moduleId, type: '00' };
      break;
      
    case 'calibrateWeight':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/weightCalibration`;
      apiPayload = { moduleId: state.moduleId, type: '00' };
      break;
      
    case 'takePhoto':
      apiUrl = `${CONFIG.local.baseUrl}/system/camera/process`;
      apiPayload = {};
      break;
      
    case 'stepperMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/stepMotorSelect`;
      apiPayload = {
        moduleId: CONFIG.motors.stepper.moduleId,
        id: params.position,
        type: params.position,
        deviceType
      };
      break;
      
    case 'customMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = {
        moduleId: state.moduleId,
        motorId: params.motorId,
        type: params.type,
        deviceType
      };
      break;
      
    default:
      throw new Error(`Unknown action: ${action}`);
  }
  
  console.log(`🔧 Executing: ${action}`, apiPayload);
  
  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: CONFIG.local.timeout,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (action === 'takePhoto') await delay(1500);
    if (action === 'getWeight') await delay(2000);
    
  } catch (error) {
    console.error(`❌ ${action} failed:`, error.message);
    throw error;
  }
}

// ============================================
// REJECTION HANDLING
// ============================================
async function executeRejectionCycle() {
  console.log('\n========================================');
  console.log('❌ REJECTION CYCLE - UNRECOGNIZED ITEM');
  console.log('========================================\n');

  try {
    // 1. Move item through system without sorting
    console.log('🎯 Step 1: Belt → Stepper (rejection path)');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    console.log('✅ Step 1 complete\n');

    // 2. Keep stepper at home (reject all unrecognized)
    console.log('🎯 Step 2: Stepper remains at home');
    await delay(CONFIG.timing.positionSettle);
    console.log('✅ Step 2 complete\n');

    // 3. Reverse belt to drop into reject bin
    console.log('🎯 Step 3: Reverse Belt (to reject bin)');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    console.log('✅ Step 3 complete\n');

    console.log('========================================');
    console.log('✅ REJECTION CYCLE COMPLETE');
    console.log('========================================\n');

    // Publish rejection event
    const rejectionData = {
      deviceId: CONFIG.device.id,
      reason: 'LOW_CONFIDENCE',
      userId: state.currentUserId || null,
      sessionId: state.sessionId || null,
      sessionCode: state.sessionCode || null,
      isGuest: state.isGuestSession,
      timestamp: new Date().toISOString()
    };
    
    mqttClient.publish('rvm/RVM-3101/item/rejected', JSON.stringify(rejectionData));

  } catch (error) {
    console.error('❌ Rejection cycle error:', error.message);
  }

  // Reset detection state
  state.aiResult = null;
  state.weight = null;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  state.cycleInProgress = false;

  // Ready for next item
  if (state.autoCycleEnabled) {
    console.log('🔄 Ready for next item...\n');
    
    // Ensure gate is open for next item
    console.log('🚪 Ensuring gate is open for next item...');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('✅ Gate confirmed open, ready for next bottle!\n');
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================
async function startSession(isMember, sessionData) {
  console.log('\n========================================');
  console.log(`🎬 STARTING ${isMember ? 'MEMBER' : 'GUEST'} SESSION`);
  console.log('========================================');
  
  if (isMember) {
    console.log(`👤 User: ${sessionData.userName || sessionData.userId}`);
    console.log(`🔑 Session Code: ${sessionData.sessionCode}`);
    state.currentUserId = sessionData.userId;
    state.currentUserData = {
      name: sessionData.userName,
      email: sessionData.userEmail,
      sessionCode: sessionData.sessionCode
    };
    state.isMember = true;
    state.isGuestSession = false;
  } else {
    console.log(`🎫 Guest Session: ${sessionData.sessionCode}`);
    console.log(`📝 Session ID: ${sessionData.sessionId}`);
    state.currentUserId = null;
    state.sessionId = sessionData.sessionId;
    state.sessionCode = sessionData.sessionCode;
    state.isMember = false;
    state.isGuestSession = true;
  }
  
  console.log('========================================\n');
  
  // Enable auto cycle
  state.autoCycleEnabled = true;
  state.itemsProcessed = 0;
  state.sessionStartTime = new Date();
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  
  // Reset system
  console.log('🔧 Resetting system...');
  await executeCommand('customMotor', CONFIG.motors.belt.stop);
  await executeCommand('customMotor', CONFIG.motors.compactor.stop);
  await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
  await delay(2000);
  console.log('✅ Reset complete\n');
  
  // Open gate
  console.log('🚪 Opening gate...');
  await executeCommand('openGate');
  await delay(CONFIG.timing.gateOperation);
  console.log('✅ Gate opened!\n');
  
  // Set auto photo timer
  console.log('⏱️  Auto photo in 5 seconds...\n');
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
  }
  
  state.autoPhotoTimer = setTimeout(() => {
    console.log('📸 AUTO PHOTO!\n');
    state.awaitingDetection = true;
    executeCommand('takePhoto');
  }, CONFIG.timing.autoPhotoDelay);
}

async function resetSystemForNextUser() {
  console.log('\n========================================');
  console.log('🔄 RESETTING SYSTEM FOR NEXT USER');
  console.log('========================================\n');
  
  try {
    // Close gate
    console.log('🚪 Closing gate...');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('✅ Gate closed\n');
    
    // Stop all motors
    console.log('🛑 Stopping all motors...');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    console.log('✅ Motors stopped\n');
    
    // Reset stepper to home
    console.log('🏠 Resetting stepper to home...');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    console.log('✅ Stepper reset\n');
    
  } catch (error) {
    console.error('❌ Reset error:', error.message);
  }
  
  // Clear all state
  state.aiResult = null;
  state.weight = null;
  state.currentUserId = null;
  state.currentUserData = null;
  state.sessionId = null;
  state.sessionCode = null;
  state.calibrationAttempts = 0;
  state.autoCycleEnabled = false;
  state.cycleInProgress = false;
  state.isMember = false;
  state.isGuestSession = false;
  state.itemsProcessed = 0;
  state.sessionStartTime = null;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  console.log('========================================');
  console.log('✅ SYSTEM READY FOR NEXT USER');
  console.log('========================================\n');
}

// ============================================
// AUTO CYCLE PROCESSING
// ============================================
async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    console.log('⚠️ Missing data for auto cycle');
    state.cycleInProgress = false;
    return;
  }

  state.itemsProcessed++;
  
  console.log('\n========================================');
  console.log(`🤖 AUTO CYCLE START - ITEM #${state.itemsProcessed}`);
  console.log('========================================');
  console.log(`📦 Material: ${state.aiResult.materialType}`);
  console.log(`⚖️  Weight: ${state.weight.weight}g`);
  console.log('========================================\n');

  try {
    // 1. Move belt to stepper
    console.log('🎯 Step 1: Belt → Stepper');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    console.log('✅ Step 1 complete\n');

    // 2. Rotate stepper to position
    console.log('🎯 Step 2: Stepper Rotation');
    const targetPosition = state.aiResult.materialType === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    await executeCommand('stepperMotor', { position: targetPosition });
    await delay(CONFIG.timing.stepperRotate);
    console.log('✅ Step 2 complete\n');

    // 3. Reverse belt
    console.log('🎯 Step 3: Reverse Belt');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    console.log('✅ Step 3 complete\n');

    // 4. Reset stepper
    console.log('🎯 Step 4: Reset Stepper');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    console.log('✅ Step 4 complete\n');

    // 5. Compactor
    console.log('🎯 Step 5: Compactor');
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    console.log('✅ Step 5 complete\n');

    // 6. Publish cycle complete to backend
    console.log('📤 Publishing cycle complete...');
    const cycleData = {
      deviceId: CONFIG.device.id,
      material: state.aiResult.materialType,
      weight: state.weight.weight,
      userId: state.currentUserId || null,
      sessionId: state.sessionId || null,
      sessionCode: state.sessionCode || null,
      isGuest: state.isGuestSession,
      itemNumber: state.itemsProcessed,
      timestamp: new Date().toISOString()
    };
    
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));
    console.log('✅ Cycle complete published\n');

    console.log('========================================');
    console.log(`✅ AUTO CYCLE COMPLETE - ITEM #${state.itemsProcessed}`);
    console.log('========================================\n');

  } catch (error) {
    console.error('❌ Auto cycle error:', error.message);
  }

  // Reset for next bottle
  state.aiResult = null;
  state.weight = null;
  state.calibrationAttempts = 0;
  state.cycleInProgress = false;
  state.detectionRetries = 0;
  state.awaitingDetection = false;

  // ✅ Keep session active for next item
  if (state.autoCycleEnabled) {
    console.log('🔄 Ready for next item (session still active)...\n');
    console.log(`📊 Session stats: ${state.itemsProcessed} items processed\n`);
    
    // Ensure gate is open for next item
    console.log('🚪 Ensuring gate is open for next item...');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('✅ Gate confirmed open, ready for next bottle!\n');
  }
}

// ============================================
// WEBSOCKET CONNECTION
// ============================================
function connectWebSocket() {
  console.log('🔌 Connecting to WebSocket...');
  
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    console.log('✅ WebSocket connected\n');
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Module ID
      if (message.function === '01') {
        state.moduleId = message.moduleId;
        console.log(`📟 Module ID: ${state.moduleId}\n`);
        return;
      }
      
      // AI Result
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        const materialType = determineMaterialType(aiData);
        
        state.aiResult = {
          matchRate: Math.round((aiData.probability || 0) * 100),
          materialType: materialType,
          className: aiData.className,
          taskId: aiData.taskId,
          timestamp: new Date().toISOString()
        };
        
        console.log(`🤖 AI: ${materialType} (${state.aiResult.matchRate}%)`);
        
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        
        // Handle detection result
        if (state.autoCycleEnabled && state.awaitingDetection) {
          if (state.aiResult.materialType !== 'UNKNOWN') {
            // Success! Proceed to weight
            console.log('✅ Material identified, proceeding to weight...\n');
            state.detectionRetries = 0;
            state.awaitingDetection = false;
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            // Unknown material
            state.detectionRetries++;
            console.log(`⚠️ UNKNOWN material (Attempt ${state.detectionRetries}/${CONFIG.detection.maxRetries})\n`);
            
            if (state.detectionRetries < CONFIG.detection.maxRetries) {
              // Retry photo capture
              console.log(`🔄 Retrying photo in ${CONFIG.detection.retryDelay/1000} seconds...\n`);
              setTimeout(() => {
                console.log('📸 RETRY PHOTO!\n');
                executeCommand('takePhoto');
              }, CONFIG.detection.retryDelay);
            } else {
              // Max retries reached, reject item
              console.log('❌ Max retries reached, rejecting item...\n');
              state.awaitingDetection = false;
              state.cycleInProgress = true;
              setTimeout(() => executeRejectionCycle(), 1000);
            }
          }
        }
        return;
      }
      
      // Weight Result
      if (message.function === '06') {
        const weightValue = parseFloat(message.data) || 0;
        const coefficient = CONFIG.weight.coefficients[1];
        const calibratedWeight = weightValue * (coefficient / 1000);
        
        state.weight = {
          weight: Math.round(calibratedWeight * 10) / 10,
          rawWeight: weightValue,
          coefficient: coefficient,
          timestamp: new Date().toISOString()
        };
        
        console.log(`⚖️ Weight: ${state.weight.weight}g`);
        
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));
        
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          console.log(`⚠️ Calibrating (${state.calibrationAttempts}/2)...\n`);
          setTimeout(async () => {
            await executeCommand('calibrateWeight');
            setTimeout(() => executeCommand('getWeight'), 1000);
          }, 500);
          return;
        }
        
        if (state.weight.weight > 0) state.calibrationAttempts = 0;
        
        if (state.autoCycleEnabled && state.aiResult && state.weight.weight > 1 && !state.cycleInProgress) {
          state.cycleInProgress = true;
          setTimeout(() => executeAutoCycle(), 1000);
        }
        return;
      }
      
      // Device Status (object detection)
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        
        if (code === 4 && state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
          console.log('👤 OBJECT DETECTED!\n');
          state.awaitingDetection = true;
          state.detectionRetries = 0;
          
          if (state.autoPhotoTimer) {
            clearTimeout(state.autoPhotoTimer);
            state.autoPhotoTimer = null;
          }
          setTimeout(() => executeCommand('takePhoto'), 1000);
        }
        return;
      }
      
    } catch (error) {
      console.error('❌ WS error:', error.message);
    }
  });
  
  state.ws.on('close', () => {
    console.log('⚠️ WS closed, reconnecting...');
    setTimeout(connectWebSocket, 5000);
  });
  
  state.ws.on('error', (error) => {
    console.error('❌ WS error:', error.message);
  });
}

// ============================================
// MQTT CONNECTION
// ============================================
const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  console.log('✅ MQTT connected');
  
  // Subscribe to topics
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.autoControl);
  mqttClient.subscribe(CONFIG.mqtt.topics.qrScan);       // Member QR validated
  mqttClient.subscribe(CONFIG.mqtt.topics.guestStart);   // Guest session started
  mqttClient.subscribe(CONFIG.mqtt.topics.screenState);  // Monitor screen updates
  
  // Publish online status
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'online',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  // Connect WebSocket
  connectWebSocket();
  
  // Request module ID
  setTimeout(() => {
    requestModuleId();
  }, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    // ============================================
    // MEMBER QR SCAN (QR validated by backend)
    // ============================================
    if (topic === CONFIG.mqtt.topics.qrScan) {
      // Prevent duplicate sessions
      if (state.cycleInProgress) {
        console.log('⚠️ Cycle in progress, ignoring QR scan');
        return;
      }
      
      if (state.autoCycleEnabled) {
        console.log('⚠️ System already active, ignoring QR scan');
        return;
      }
      
      // Start member session
      await startSession(true, payload);
      return;
    }
    
    // ============================================
    // GUEST SESSION START
    // ============================================
    if (topic === CONFIG.mqtt.topics.guestStart) {
      // Prevent duplicate sessions
      if (state.cycleInProgress) {
        console.log('⚠️ Cycle in progress, ignoring guest start');
        return;
      }
      
      if (state.autoCycleEnabled) {
        console.log('⚠️ System already active, ignoring guest start');
        return;
      }
      
      // Start guest session
      await startSession(false, payload);
      return;
    }
    
    // ============================================
    // SCREEN STATE (from backend)
    // ============================================
    if (topic === CONFIG.mqtt.topics.screenState) {
      console.log(`📺 Screen update: ${payload.state}`);
      // Agent can log or react to screen state changes
      return;
    }
    
    // ============================================
    // MANUAL CONTROL
    // ============================================
    if (topic === CONFIG.mqtt.topics.autoControl) {
      state.autoCycleEnabled = payload.enabled === true;
      console.log(`🤖 Auto: ${state.autoCycleEnabled ? 'ON' : 'OFF'}`);
      
      if (state.autoCycleEnabled && state.moduleId) {
        await executeCommand('openGate');
      } else if (!state.autoCycleEnabled && state.moduleId) {
        await executeCommand('closeGate');
      }
      return;
    }
    
    // ============================================
    // COMMANDS
    // ============================================
    if (topic === CONFIG.mqtt.topics.commands) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (payload.action === 'emergencyStop') {
        console.log('🚨 EMERGENCY STOP');
        await executeCommand('closeGate');
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        await executeCommand('customMotor', CONFIG.motors.compactor.stop);
        state.autoCycleEnabled = false;
        state.cycleInProgress = false;
        state.awaitingDetection = false;
        state.detectionRetries = 0;
        return;
      }
      
      if (payload.action === 'endSession') {
        console.log('🏁 SESSION END COMMAND');
        await resetSystemForNextUser();
        return;
      }
      
      if (payload.action === 'takePhoto' && state.moduleId) {
        console.log('📸 MANUAL PHOTO!\n');
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        state.awaitingDetection = true;
        state.detectionRetries = 0;
        await executeCommand('takePhoto');
        return;
      }
      
      if (payload.action === 'setMaterial') {
        const validMaterials = ['METAL_CAN', 'PLASTIC_BOTTLE', 'GLASS'];
        if (validMaterials.includes(payload.materialType)) {
          state.aiResult = {
            matchRate: 100,
            materialType: payload.materialType,
            className: 'MANUAL',
            taskId: 'manual_' + Date.now(),
            timestamp: new Date().toISOString()
          };
          console.log(`🔧 Manual: ${payload.materialType}`);
          
          state.detectionRetries = 0;
          state.awaitingDetection = false;
          
          if (state.autoCycleEnabled) {
            setTimeout(() => executeCommand('getWeight'), 500);
          }
        }
        return;
      }
      
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      }
    }
    
  } catch (error) {
    console.error('❌ MQTT error:', error.message);
  }
});

// ============================================
// INITIALIZATION
// ============================================
async function requestModuleId() {
  try {
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('❌ Module ID request failed:', error.message);
  }
}

function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...');
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) state.ws.close();
  mqttClient.end();
  
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ============================================
// STARTUP
// ============================================
console.log('========================================');
console.log('🚀 RVM AGENT - MULTI-ITEM SUPPORT');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log(`🔐 Backend: ${CONFIG.backend.url}`);
console.log('✅ Member: QR → Multiple items');
console.log('✅ Guest: No QR → Multiple items');
console.log('✅ Retry: 3 attempts for low confidence');
console.log('✅ Reject: Auto-reject unrecognized items');
console.log('========================================');
console.log('⏳ Starting...\n');