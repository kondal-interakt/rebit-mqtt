// agent.js - Fixed QR Scanning After Guest Session
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  device: {
    id: 'RVM-3101'
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
      qrScan: 'rvm/RVM-3101/qr/scanned',
      guestStart: 'rvm/RVM-3101/guest/start',
      screenState: 'rvm/RVM-3101/screen/state'
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
    retryDelay: 2000,
    maxRetries: 3,
    hasObjectSensor: false,
    minValidWeight: 5
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
    autoPhotoDelay: 5000,
    sessionTimeout: 120000,
    sessionMaxDuration: 600000
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
  isReady: false,         // 🔒 CRITICAL: System ready for new session
  
  // Session tracking
  sessionId: null,
  sessionCode: null,
  currentUserId: null,
  currentUserData: null,
  isMember: false,
  isGuestSession: false,
  
  // Multi-item tracking
  itemsProcessed: 0,
  sessionStartTime: null,
  lastActivityTime: null,
  sessionTimeoutTimer: null,
  maxDurationTimer: null,
  
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
  
  if (className.includes('易拉罐') || className.includes('metal') || 
      className.includes('can') || className.includes('铝')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = className.includes('易拉罐') || className.includes('铝');
  } 
  else if (className.includes('pet') || className.includes('plastic') || 
           className.includes('瓶') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = className.includes('pet');
  } 
  else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS';
    threshold = CONFIG.detection.GLASS;
    hasStrongKeyword = className.includes('玻璃');
  }
  
  const confidencePercent = Math.round(probability * 100);
  const thresholdPercent = Math.round(threshold * 100);
  
  if (materialType !== 'UNKNOWN' && probability < threshold) {
    const relaxedThreshold = threshold * 0.3;
    
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
    console.log('🎯 Reversing belt to reject bin (item rejected before sorting)');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    console.log('✅ Item dropped into reject bin\n');

    console.log('========================================');
    console.log('✅ REJECTION CYCLE COMPLETE');
    console.log('========================================\n');

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

  state.aiResult = null;
  state.weight = null;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  state.cycleInProgress = false;
  
  console.log('📊 State after rejection:');
  console.log(`   - cycleInProgress: ${state.cycleInProgress}`);
  console.log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`);
  console.log(`   - awaitingDetection: ${state.awaitingDetection}\n`);

  if (state.autoCycleEnabled) {
    console.log('🔄 Ready for next item...\n');
    
    console.log('🚪 Ensuring gate is open for next item...');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('✅ Gate confirmed open, ready for next bottle!\n');
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    console.log('⏱️  Auto photo timer: 5 seconds...\n');
    state.autoPhotoTimer = setTimeout(() => {
      if (!state.cycleInProgress && !state.awaitingDetection) {
        console.log('📸 AUTO PHOTO (after rejection)\n');
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
  }
}

// ============================================
// SESSION TIMEOUT HANDLING
// ============================================
async function handleSessionTimeout(reason) {
  console.log('\n========================================');
  console.log('⏱️  SESSION TIMEOUT');
  console.log('========================================');
  console.log(`Reason: ${reason}`);
  console.log(`Items processed: ${state.itemsProcessed}`);
  console.log(`Session duration: ${Math.round((Date.now() - state.sessionStartTime) / 1000)}s`);
  console.log('========================================\n');
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'timeout',
    event: 'session_timeout',
    reason: reason,
    itemsProcessed: state.itemsProcessed,
    userId: state.currentUserId,
    sessionId: state.sessionId,
    sessionCode: state.sessionCode,
    isGuest: state.isGuestSession,
    timestamp: new Date().toISOString()
  }));
  
  await resetSystemForNextUser();
}

function resetInactivityTimer() {
  if (state.sessionTimeoutTimer) {
    clearTimeout(state.sessionTimeoutTimer);
  }
  
  state.lastActivityTime = Date.now();
  
  state.sessionTimeoutTimer = setTimeout(() => {
    handleSessionTimeout('inactivity');
  }, CONFIG.timing.sessionTimeout);
}

function startSessionTimers() {
  resetInactivityTimer();
  
  if (state.maxDurationTimer) {
    clearTimeout(state.maxDurationTimer);
  }
  
  state.maxDurationTimer = setTimeout(() => {
    handleSessionTimeout('max_duration');
  }, CONFIG.timing.sessionMaxDuration);
}

function clearSessionTimers() {
  if (state.sessionTimeoutTimer) {
    clearTimeout(state.sessionTimeoutTimer);
    state.sessionTimeoutTimer = null;
  }
  
  if (state.maxDurationTimer) {
    clearTimeout(state.maxDurationTimer);
    state.maxDurationTimer = null;
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================
async function startSession(isMember, sessionData) {
  console.log('\n========================================');
  console.log(`🎬 STARTING ${isMember ? 'MEMBER' : 'GUEST'} SESSION`);
  console.log('========================================');
  
  // 🔒 Mark system as not ready during session start
  state.isReady = false;
  
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
    state.sessionCode = sessionData.sessionCode;
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
  
  state.autoCycleEnabled = true;
  state.itemsProcessed = 0;
  state.sessionStartTime = new Date();
  state.lastActivityTime = Date.now();
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  
  console.log(`⏱️  Session timeouts:`);
  console.log(`   - Inactivity timeout: ${CONFIG.timing.sessionTimeout / 1000}s (resets on each bottle)`);
  console.log(`   - Maximum duration: ${CONFIG.timing.sessionMaxDuration / 1000}s (absolute limit)\n`);
  startSessionTimers();
  
  console.log('🔧 Resetting system...');
  await executeCommand('customMotor', CONFIG.motors.belt.stop);
  await executeCommand('customMotor', CONFIG.motors.compactor.stop);
  await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
  await delay(2000);
  console.log('✅ Reset complete\n');
  
  console.log('⚖️ Calibrating weight sensor (ensure machine is empty)...');
  await executeCommand('calibrateWeight');
  await delay(1500);
  console.log('✅ Weight sensor zeroed\n');
  
  console.log('🚪 Opening gate...');
  await executeCommand('openGate');
  await delay(CONFIG.timing.gateOperation);
  console.log('✅ Gate opened!\n');
  
  console.log('⏱️  Auto photo timer: 5 seconds...');
  console.log('💡 System will validate weight before processing\n');
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
  }
  
  state.autoPhotoTimer = setTimeout(() => {
    console.log('📸 AUTO PHOTO (timer-based detection)\n');
    state.awaitingDetection = true;
    executeCommand('takePhoto');
  }, CONFIG.timing.autoPhotoDelay);
  
  // 📤 Publish session started event
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'session_active',
    event: 'session_started',
    sessionType: isMember ? 'member' : 'guest',
    userId: state.currentUserId,
    sessionId: state.sessionId,
    sessionCode: state.sessionCode,
    timestamp: new Date().toISOString()
  }));
}

async function resetSystemForNextUser() {
  console.log('\n========================================');
  console.log('🔄 RESETTING SYSTEM FOR NEXT USER');
  console.log('========================================');
  console.log(`📊 Current State Before Reset:`);
  console.log(`   - cycleInProgress: ${state.cycleInProgress}`);
  console.log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`);
  console.log(`   - awaitingDetection: ${state.awaitingDetection}`);
  console.log(`   - isReady: ${state.isReady}`);
  console.log('========================================\n');
  
  // 🔒 CRITICAL: Don't reset during active cycle
  if (state.cycleInProgress) {
    console.log('⚠️ Cannot reset - cycle in progress! Will retry in 2 seconds...\n');
    setTimeout(() => resetSystemForNextUser(), 2000);
    return;
  }
  
  // 🛑 FORCE stop everything first
  console.log('🛑 Force stopping all operations...');
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  state.detectionRetries = 0;
  state.isReady = false;  // 🔒 Mark as not ready
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  console.log('✅ Operations stopped\n');
  
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
    
    console.log('🏠 Stepper will reset at next session start\n');
    
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
  state.lastActivityTime = null;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  clearSessionTimers();
  
  // 🔓 Mark system as ready BEFORE publishing
  state.isReady = true;
  
  console.log('========================================');
  console.log('✅ SYSTEM READY FOR NEXT USER');
  console.log('========================================');
  console.log(`📊 Final State After Reset:`);
  console.log(`   - cycleInProgress: ${state.cycleInProgress}`);
  console.log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`);
  console.log(`   - awaitingDetection: ${state.awaitingDetection}`);
  console.log(`   - isReady: ${state.isReady}`);
  console.log(`   - moduleId: ${state.moduleId ? 'SET' : 'NULL'}`);
  console.log('========================================\n');
  
  // ✅ Notify backend that reset is complete and ready for new session
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'ready',
    event: 'reset_complete',
    isReady: true,
    timestamp: new Date().toISOString()
  }), { retain: false });  // Don't retain this message
  
  console.log('📤 Reset complete notification sent to backend\n');
  console.log('🟢 SYSTEM IS NOW READY FOR QR SCAN OR GUEST SESSION\n');
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
  
  console.log('\n========================================');
  console.log(`🤖 AUTO CYCLE START - ITEM #${state.itemsProcessed}`);
  console.log('========================================');
  console.log(`📦 Material: ${cycleData.material}`);
  console.log(`⚖️  Weight: ${cycleData.weight}g`);
  console.log('========================================\n');

  try {
    console.log('🎯 Step 1: Belt → Stepper');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    console.log('✅ Step 1 complete\n');

    console.log('🎯 Step 2: Stepper Rotation');
    const targetPosition = cycleData.material === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    await executeCommand('stepperMotor', { position: targetPosition });
    await delay(CONFIG.timing.stepperRotate);
    console.log('✅ Step 2 complete\n');

    console.log('🎯 Step 3: Reverse Belt');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    console.log('✅ Step 3 complete\n');

    console.log('🎯 Step 4: Reset Stepper');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    console.log('✅ Step 4 complete\n');

    console.log('🎯 Step 5: Compactor');
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    console.log('✅ Step 5 complete\n');

    console.log('📤 Publishing cycle complete...');
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));
    console.log('✅ Cycle complete published\n');

    console.log('========================================');
    console.log(`✅ AUTO CYCLE COMPLETE - ITEM #${state.itemsProcessed}`);
    console.log('========================================\n');
    
    resetInactivityTimer();

  } catch (error) {
    console.error('❌ Auto cycle error:', error.message);
  }

  state.aiResult = null;
  state.weight = null;
  state.calibrationAttempts = 0;
  state.cycleInProgress = false;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  
  console.log('📊 State after cycle:');
  console.log(`   - cycleInProgress: ${state.cycleInProgress}`);
  console.log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`);
  console.log(`   - awaitingDetection: ${state.awaitingDetection}\n`);

  if (state.autoCycleEnabled) {
    console.log('🔄 Ready for next item (session still active)...\n');
    console.log(`📊 Session stats: ${state.itemsProcessed} items processed\n`);
    
    console.log('🚪 Ensuring gate is open for next item...');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('✅ Gate confirmed open, ready for next bottle!\n');
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    console.log('⏱️  Auto photo timer: 5 seconds...\n');
    state.autoPhotoTimer = setTimeout(() => {
      if (!state.cycleInProgress && !state.awaitingDetection) {
        console.log('📸 AUTO PHOTO (next item detection)\n');
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
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
      
      if (message.function === '01') {
        state.moduleId = message.moduleId;
        console.log(`📟 Module ID: ${state.moduleId}\n`);
        return;
      }
      
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
        
        if (state.autoCycleEnabled && state.awaitingDetection) {
          if (state.aiResult.materialType !== 'UNKNOWN') {
            console.log('✅ Material identified, proceeding to weight...\n');
            state.detectionRetries = 0;
            state.awaitingDetection = false;
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            state.detectionRetries++;
            console.log(`⚠️ UNKNOWN material (Attempt ${state.detectionRetries}/${CONFIG.detection.maxRetries})\n`);
            
            if (state.detectionRetries < CONFIG.detection.maxRetries) {
              console.log(`🔄 Retrying photo in ${CONFIG.detection.retryDelay/1000} seconds...\n`);
              setTimeout(() => {
                console.log('📸 RETRY PHOTO!\n');
                executeCommand('takePhoto');
              }, CONFIG.detection.retryDelay);
            } else {
              console.log('❌ Max retries reached, rejecting item...\n');
              state.awaitingDetection = false;
              state.cycleInProgress = true;
              setTimeout(() => executeRejectionCycle(), 1000);
            }
          }
        }
        return;
      }
      
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
        
        console.log(`⚖️ Weight: ${state.weight.weight}g (raw: ${state.weight.rawWeight})`);
        
        if (state.weight.weight > 500 && state.calibrationAttempts === 0) {
          console.log(`⚠️ WARNING: Suspiciously high weight detected (${state.weight.weight}g)`);
          console.log(`⚠️ This may indicate scale needs zeroing/calibration\n`);
        }
        
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
        
        if (state.autoCycleEnabled && state.aiResult && !state.cycleInProgress) {
          if (state.weight.weight < CONFIG.detection.minValidWeight) {
            console.log(`\n⚠️ ========================================`);
            console.log(`⚠️ WEIGHT TOO LOW: ${state.weight.weight}g`);
            console.log(`⚠️ Minimum required: ${CONFIG.detection.minValidWeight}g`);
            console.log(`⚠️ Likely empty machine or sensor error`);
            console.log(`⚠️ Skipping cycle - waiting for real bottle`);
            console.log(`⚠️ ========================================\n`);
            
            state.aiResult = null;
            state.weight = null;
            state.awaitingDetection = false;
            state.detectionRetries = 0;
            
            if (state.autoPhotoTimer) {
              clearTimeout(state.autoPhotoTimer);
            }
            console.log('⏱️  Retrying in 5 seconds...\n');
            state.autoPhotoTimer = setTimeout(() => {
              if (!state.cycleInProgress && !state.awaitingDetection) {
                console.log('📸 AUTO PHOTO (retry after low weight)\n');
                state.awaitingDetection = true;
                executeCommand('takePhoto');
              }
            }, CONFIG.timing.autoPhotoDelay);
            
            return;
          }
          
          state.cycleInProgress = true;
          setTimeout(() => executeAutoCycle(), 1000);
        }
        return;
      }
      
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        console.log(`📊 Device Status Code: ${code}`);
        
        if (code >= 0 && code <= 3) {
          const binNames = ['Left (PET)', 'Middle (Metal)', 'Right', 'Glass'];
          console.log(`⚠️ Bin Full Alert: ${binNames[code]} bin is full!\n`);
        }
        
        if (code === 4 && state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
          console.log('\n========================================');
          console.log('👁️  OBJECT DETECTED BY SENSOR (UNEXPECTED!)');
          console.log('========================================\n');
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
  
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.autoControl);
  mqttClient.subscribe(CONFIG.mqtt.topics.qrScan);
  mqttClient.subscribe(CONFIG.mqtt.topics.guestStart);
  mqttClient.subscribe(CONFIG.mqtt.topics.screenState);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'online',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  connectWebSocket();
  
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
      console.log('\n========================================');
      console.log('📱 QR SCAN RECEIVED');
      console.log('========================================');
      console.log(`👤 User: ${payload.userName || payload.userId}`);
      console.log(`🔑 Session Code: ${payload.sessionCode}`);
      console.log(`📊 Current State:`);
      console.log(`   - isReady: ${state.isReady}`);
      console.log(`   - cycleInProgress: ${state.cycleInProgress}`);
      console.log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`);
      console.log(`   - awaitingDetection: ${state.awaitingDetection}`);
      console.log(`   - moduleId: ${state.moduleId ? 'SET' : 'NULL'}`);
      console.log('========================================\n');
      
      // 🔒 CRITICAL: Validate system is ready
      if (!state.isReady) {
        console.log('❌ SYSTEM NOT READY - Rejecting QR scan');
        console.log('⚠️ System must complete reset before accepting new session\n');
        
        // Notify backend that device is not ready
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id,
          status: 'busy',
          event: 'qr_rejected',
          reason: 'system_not_ready',
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      // Validate module ID
      if (!state.moduleId) {
        console.log('❌ MODULE ID NOT SET - Cannot start session');
        console.log('🔄 Requesting module ID...\n');
        await requestModuleId();
        await delay(1000);
        
        if (!state.moduleId) {
          console.log('❌ Failed to get module ID - rejecting QR scan\n');
          return;
        }
      }
      
      // Prevent duplicate sessions
      if (state.cycleInProgress) {
        console.log('⚠️ Cycle in progress, ignoring QR scan\n');
        return;
      }
      
      if (state.autoCycleEnabled) {
        console.log('⚠️ System already active, forcing cleanup...\n');
        state.autoCycleEnabled = false;
        state.awaitingDetection = false;
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        await delay(500);
      }
      
      console.log('✅ All validations passed - starting member session\n');
      
      // Start member session
      await startSession(true, payload);
      return;
    }
    
    // ============================================
    // GUEST SESSION START
    // ============================================
    if (topic === CONFIG.mqtt.topics.guestStart) {
      console.log('\n========================================');
      console.log('🎫 GUEST SESSION START RECEIVED');
      console.log('========================================');
      console.log(`📊 Current State:`);
      console.log(`   - isReady: ${state.isReady}`);
      console.log(`   - cycleInProgress: ${state.cycleInProgress}`);
      console.log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`);
      console.log('========================================\n');
      
      // 🔒 Validate system is ready
      if (!state.isReady) {
        console.log('❌ SYSTEM NOT READY - Rejecting guest start\n');
        return;
      }
      
      if (state.cycleInProgress) {
        console.log('⚠️ Cycle in progress, ignoring guest start\n');
        return;
      }
      
      if (state.autoCycleEnabled) {
        console.log('⚠️ System already active, ignoring guest start\n');
        return;
      }
      
      console.log('✅ All validations passed - starting guest session\n');
      
      // Start guest session
      await startSession(false, payload);
      return;
    }
    
    // ============================================
    // SCREEN STATE (from backend)
    // ============================================
    if (topic === CONFIG.mqtt.topics.screenState) {
      console.log(`📺 Screen update: ${payload.state}`);
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
        state.isReady = false;
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        return;
      }
      
      if (payload.action === 'forceReset') {
        console.log('🚨 FORCE RESET - Emergency state cleanup');
        console.log('⚠️ Overriding cycle protection...\n');
        const wasCycleInProgress = state.cycleInProgress;
        state.cycleInProgress = false;
        await resetSystemForNextUser();
        console.log(`✅ Force reset complete (cycle was: ${wasCycleInProgress})\n`);
        return;
      }
      
      if (payload.action === 'endSession') {
        console.log('🏁 SESSION END COMMAND');
        if (state.cycleInProgress) {
          console.log('⚠️ Session end requested during active cycle - will wait for completion\n');
        }
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
      
      if (payload.action === 'calibrateWeight' && state.moduleId) {
        console.log('⚖️ MANUAL WEIGHT CALIBRATION\n');
        await executeCommand('calibrateWeight');
        await delay(1000);
        await executeCommand('getWeight');
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
    console.log('📟 Module ID requested');
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
console.log('🚀 RVM AGENT - MULTI-ITEM SUPPORT [FIXED QR]');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log(`🔐 Backend: ${CONFIG.backend.url}`);
console.log('✅ Member: QR → Multiple items');
console.log('✅ Guest: No QR → Multiple items');
console.log('✅ Retry: 3 attempts for low confidence');
console.log('✅ Reject: Auto-reject unrecognized items');
console.log('✅ Weight validation: Min 5g to prevent false cycles');
console.log('⏱️  Inactivity timeout: 2 minutes');
console.log('⏱️  Max session duration: 10 minutes');
console.log('🔒 Ready state validation for QR scans');
console.log('========================================');
console.log('⏳ Starting...\n');

// Mark as ready after module ID is received
setTimeout(() => {
  if (state.moduleId) {
    state.isReady = true;
    console.log('🟢 SYSTEM MARKED AS READY (Module ID received)\n');
  }
}, 3000);