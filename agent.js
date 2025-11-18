// agent.js - Fixed Multi-Item Flow (Immediate Gate Closure on Session End)
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
  isReady: false,
  
  // 🔄 PARALLEL COMPACTOR TRACKING
  compactorRunning: false,
  compactorTimer: null,
  
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
  awaitingDetection: false,
  
  // 🆕 Reset tracking
  resetting: false
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
// COMPACTOR MANAGEMENT (PARALLEL OPERATION)
// ============================================
async function startCompactor() {
  // Wait if compactor is already running
  if (state.compactorRunning) {
    console.log('⏳ Waiting for previous compactor cycle to complete...');
    const startWait = Date.now();
    
    // Wait with timeout
    while (state.compactorRunning && (Date.now() - startWait) < CONFIG.timing.compactor + 5000) {
      await delay(500);
    }
    
    if (state.compactorRunning) {
      console.log('⚠️ Compactor timeout - forcing stop');
      await executeCommand('customMotor', CONFIG.motors.compactor.stop);
      state.compactorRunning = false;
    }
  }
  
  console.log('🎯 Step 5: Starting Compactor (parallel operation)');
  
  // Start compactor
  state.compactorRunning = true;
  await executeCommand('customMotor', CONFIG.motors.compactor.start);
  
  // Set timer to stop compactor after configured duration
  if (state.compactorTimer) {
    clearTimeout(state.compactorTimer);
  }
  
  state.compactorTimer = setTimeout(async () => {
    console.log('✅ Step 5 complete: Compactor finished (background)');
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    state.compactorRunning = false;
    state.compactorTimer = null;
  }, CONFIG.timing.compactor);
  
  console.log(`⚡ Compactor running in background (${CONFIG.timing.compactor / 1000}s)`);
  console.log('✅ Ready for next bottle immediately!\n');
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
// SESSION TIMEOUT HANDLING - 🔧 FIXED
// ============================================
async function handleSessionTimeout(reason) {
  console.log('\n========================================');
  console.log('⏱️  SESSION TIMEOUT');
  console.log('========================================');
  console.log(`Reason: ${reason}`);
  console.log(`Items processed: ${state.itemsProcessed}`);
  console.log(`Session duration: ${Math.round((Date.now() - state.sessionStartTime) / 1000)}s`);
  console.log(`📊 Current State Before Timeout Reset:`);
  console.log(`   - cycleInProgress: ${state.cycleInProgress}`);
  console.log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`);
  console.log(`   - compactorRunning: ${state.compactorRunning}`);
  console.log(`   - isReady: ${state.isReady}`);
  console.log(`   - resetting: ${state.resetting}`);
  console.log('========================================\n');
  
  // 🔧 FIX 1: Stop accepting new items immediately
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
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
  
  // 🔧 FIX 2: Wait for current cycle to complete if in progress
  if (state.cycleInProgress) {
    console.log('⏳ Waiting for current cycle to complete before timeout reset...');
    const maxWait = 60000; // 60 seconds max wait
    const startWait = Date.now();
    
    while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
      await delay(1000);
      console.log(`   ⏱️  Waiting for cycle... ${Math.ceil((maxWait - (Date.now() - startWait)) / 1000)}s remaining`);
    }
    
    if (state.cycleInProgress) {
      console.log('⚠️ Cycle still in progress after timeout - forcing completion');
      state.cycleInProgress = false;
    } else {
      console.log('✅ Cycle completed, proceeding with reset');
    }
  }
  
  // Normal timeout - wait for compactor to complete last bottle
  await resetSystemForNextUser(false);
  
  console.log('✅ Session timeout reset complete - system should be ready now\n');
  console.log(`📊 Final State After Timeout: isReady = ${state.isReady}\n`);
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
  
  // 🔄 Stop compactor if running from previous session
  if (state.compactorRunning) {
    console.log('⏳ Waiting for compactor to complete...');
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    if (state.compactorTimer) {
      clearTimeout(state.compactorTimer);
      state.compactorTimer = null;
    }
    state.compactorRunning = false;
  }
  
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

// 🔧 FIXED: Gate closes immediately on session end
async function resetSystemForNextUser(forceStop = false) {
  console.log('\n========================================');
  console.log('🔄 RESETTING SYSTEM FOR NEXT USER');
  console.log('========================================');
  console.log(`📊 Current State Before Reset:`);
  console.log(`   - cycleInProgress: ${state.cycleInProgress}`);
  console.log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`);
  console.log(`   - compactorRunning: ${state.compactorRunning}`);
  console.log(`   - isReady: ${state.isReady}`);
  console.log(`   - resetting: ${state.resetting}`);
  console.log(`   - forceStop: ${forceStop}`);
  console.log('========================================\n');
  
  // 🔧 FIX 3: Prevent multiple concurrent resets
  if (state.resetting) {
    console.log('⚠️ Reset already in progress, skipping duplicate reset request\n');
    return;
  }
  
  state.resetting = true;
  
  // 🆕 FIX: Close gate IMMEDIATELY - before any waiting
  console.log('🚪 Closing gate immediately (session ended)...');
  try {
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('✅ Gate closed - no more items can be inserted\n');
  } catch (error) {
    console.error('❌ Gate closure error:', error.message);
  }
  
  // Stop accepting new items immediately
  console.log('🛑 Stopping auto cycle and timers...');
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  state.detectionRetries = 0;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  console.log('✅ Auto operations stopped\n');
  
  // 🔧 FIX 4: Wait for cycle completion with better retry logic
  if (state.cycleInProgress) {
    console.log('⏳ Cycle in progress - waiting for completion before final cleanup...');
    const maxWait = 60000; // 60 seconds
    const startWait = Date.now();
    let attempts = 0;
    
    while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
      await delay(2000);
      attempts++;
      const remainingTime = Math.ceil((maxWait - (Date.now() - startWait)) / 1000);
      console.log(`   ⏱️  Attempt ${attempts}: Waiting for cycle... ${remainingTime}s remaining`);
    }
    
    if (state.cycleInProgress) {
      console.log('⚠️ Cycle still in progress after max wait - forcing completion');
      state.cycleInProgress = false;
    } else {
      console.log('✅ Cycle completed naturally\n');
    }
  }
  
  try {
    // 🔄 Handle compactor gracefully
    if (state.compactorRunning) {
      if (forceStop) {
        // Emergency: Force stop immediately
        console.log('🚨 FORCE STOPPING compactor (emergency)...');
        await executeCommand('customMotor', CONFIG.motors.compactor.stop);
        if (state.compactorTimer) {
          clearTimeout(state.compactorTimer);
          state.compactorTimer = null;
        }
        state.compactorRunning = false;
        console.log('✅ Compactor force stopped\n');
      } else {
        // Normal session end: Wait for compactor to complete naturally
        console.log('⏳ Waiting for compactor to complete last bottle...');
        console.log('💡 Gate is already closed - safely finishing last item\n');
        const maxWaitTime = CONFIG.timing.compactor + 2000; // Add 2s buffer
        const startWait = Date.now();
        
        while (state.compactorRunning && (Date.now() - startWait) < maxWaitTime) {
          await delay(1000);
          const remainingTime = Math.ceil((maxWaitTime - (Date.now() - startWait)) / 1000);
          console.log(`   ⏱️  Compactor running... ${remainingTime}s remaining`);
        }
        
        if (state.compactorRunning) {
          // Timeout - force stop
          console.log('⚠️ Compactor timeout - forcing stop');
          await executeCommand('customMotor', CONFIG.motors.compactor.stop);
          if (state.compactorTimer) {
            clearTimeout(state.compactorTimer);
            state.compactorTimer = null;
          }
          state.compactorRunning = false;
        } else {
          console.log('✅ Compactor completed naturally\n');
        }
      }
    }
    
    // Gate already closed above, but confirm it
    console.log('🚪 Confirming gate is closed...');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('✅ Gate closure confirmed\n');
    
    console.log('🛑 Stopping all motors...');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
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
  
  // 🔧 FIX 5: Always set isReady and resetting flags at the end
  state.resetting = false;
  state.isReady = true;
  
  console.log('========================================');
  console.log('✅ SYSTEM READY FOR NEXT USER');
  console.log('========================================');
  console.log(`📊 Final State After Reset:`);
  console.log(`   - cycleInProgress: ${state.cycleInProgress}`);
  console.log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`);
  console.log(`   - compactorRunning: ${state.compactorRunning}`);
  console.log(`   - isReady: ${state.isReady}`);
  console.log(`   - resetting: ${state.resetting}`);
  console.log('========================================\n');
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'ready',
    event: 'reset_complete',
    isReady: true,
    timestamp: new Date().toISOString()
  }), { retain: false });
  
  console.log('📤 Reset complete notification sent to backend\n');
  console.log('🟢 SYSTEM IS NOW READY FOR QR SCAN OR GUEST SESSION\n');
}

// ============================================
// AUTO CYCLE PROCESSING (OPTIMIZED)
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

    // ⚡ KEY IMPROVEMENT: Start compactor in parallel
    await startCompactor();

    console.log('📤 Publishing cycle complete...');
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));
    console.log('✅ Cycle complete published\n');

    console.log('========================================');
    console.log(`✅ AUTO CYCLE COMPLETE - ITEM #${state.itemsProcessed}`);
    console.log(`⚡ Compactor running in background - ready for next bottle!`);
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
  console.log(`   - compactorRunning: ${state.compactorRunning} (background)`);
  console.log(`   - awaitingDetection: ${state.awaitingDetection}\n`);

  if (state.autoCycleEnabled) {
    console.log('🔄 Ready for next item immediately (session still active)...\n');
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
// MQTT CONNECTION - 🔧 IMPROVED QR HANDLING
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
    
    // 🔧 FIX 6: Enhanced QR scan handler with better diagnostics
    if (topic === CONFIG.mqtt.topics.qrScan) {
      console.log('\n========================================');
      console.log('📱 QR SCAN RECEIVED');
      console.log('========================================');
      console.log(`👤 User: ${payload.userName || payload.userId}`);
      console.log(`🔑 Session Code: ${payload.sessionCode}`);
      console.log(`📊 Current State:`);
      console.log(`   - isReady: ${state.isReady}`);
      console.log(`   - resetting: ${state.resetting}`);
      console.log(`   - cycleInProgress: ${state.cycleInProgress}`);
      console.log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`);
      console.log(`   - compactorRunning: ${state.compactorRunning}`);
      console.log(`   - moduleId: ${state.moduleId ? 'SET' : 'NOT SET'}`);
      console.log('========================================\n');
      
      // Check if system is resetting
      if (state.resetting) {
        console.log('❌ SYSTEM CURRENTLY RESETTING - Rejecting QR scan (try again in a moment)\n');
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id,
          status: 'busy',
          event: 'qr_rejected',
          reason: 'system_resetting',
          message: 'System is currently resetting from previous session. Please try again in a moment.',
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (!state.isReady) {
        console.log('❌ SYSTEM NOT READY - Rejecting QR scan\n');
        console.log('💡 Possible reasons:');
        console.log('   - Previous session still cleaning up');
        console.log('   - Compactor still running');
        console.log('   - System initialization incomplete\n');
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id,
          status: 'busy',
          event: 'qr_rejected',
          reason: 'system_not_ready',
          cycleInProgress: state.cycleInProgress,
          compactorRunning: state.compactorRunning,
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (!state.moduleId) {
        console.log('❌ MODULE ID NOT SET - Cannot start session\n');
        await requestModuleId();
        await delay(1000);
        if (!state.moduleId) {
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id,
            status: 'error',
            event: 'qr_rejected',
            reason: 'module_id_missing',
            timestamp: new Date().toISOString()
          }));
          return;
        }
      }
      
      if (state.cycleInProgress) {
        console.log('⚠️ Cycle in progress, ignoring QR scan\n');
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id,
          status: 'busy',
          event: 'qr_rejected',
          reason: 'cycle_in_progress',
          timestamp: new Date().toISOString()
        }));
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
      await startSession(true, payload);
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.guestStart) {
      console.log('\n========================================');
      console.log('🎫 GUEST SESSION START RECEIVED');
      console.log('========================================');
      console.log(`📊 Current State:`);
      console.log(`   - isReady: ${state.isReady}`);
      console.log(`   - resetting: ${state.resetting}`);
      console.log(`   - cycleInProgress: ${state.cycleInProgress}`);
      console.log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`);
      console.log('========================================\n');
      
      if (state.resetting) {
        console.log('❌ SYSTEM CURRENTLY RESETTING - Rejecting guest start\n');
        return;
      }
      
      if (!state.isReady || state.cycleInProgress || state.autoCycleEnabled) {
        console.log('❌ SYSTEM NOT READY - Rejecting guest start\n');
        return;
      }
      
      console.log('✅ All validations passed - starting guest session\n');
      await startSession(false, payload);
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.screenState) {
      console.log(`📺 Screen update: ${payload.state}`);
      return;
    }
    
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
    
    if (topic === CONFIG.mqtt.topics.commands) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (payload.action === 'emergencyStop') {
        console.log('🚨 EMERGENCY STOP');
        await executeCommand('closeGate');
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        
        // Stop compactor immediately (emergency)
        if (state.compactorRunning) {
          await executeCommand('customMotor', CONFIG.motors.compactor.stop);
          if (state.compactorTimer) {
            clearTimeout(state.compactorTimer);
            state.compactorTimer = null;
          }
          state.compactorRunning = false;
        }
        
        state.autoCycleEnabled = false;
        state.cycleInProgress = false;
        state.resetting = false;
        state.isReady = false;
        return;
      }
      
      if (payload.action === 'forceReset') {
        console.log('🚨 FORCE RESET - Emergency state cleanup\n');
        state.cycleInProgress = false;
        state.resetting = false;
        // Force stop everything including compactor
        await resetSystemForNextUser(true);
        return;
      }
      
      if (payload.action === 'endSession') {
        console.log('🏁 SESSION END COMMAND - Gate will close immediately');
        if (state.cycleInProgress) {
          console.log('⚠️ Session end requested during active cycle - will wait for completion\n');
        }
        // Normal end - gate closes immediately, wait for compactor to complete last bottle
        await resetSystemForNextUser(false);
        return;
      }
      
      if (payload.action === 'getStatus') {
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id,
          status: state.isReady ? 'ready' : 'busy',
          event: 'status_response',
          isReady: state.isReady,
          resetting: state.resetting,
          cycleInProgress: state.cycleInProgress,
          compactorRunning: state.compactorRunning,
          itemsProcessed: state.itemsProcessed,
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (payload.action === 'takePhoto' && state.moduleId) {
        console.log('📸 MANUAL PHOTO!\n');
        state.awaitingDetection = true;
        await executeCommand('takePhoto');
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
  
  // Stop compactor if running
  if (state.compactorRunning && state.compactorTimer) {
    clearTimeout(state.compactorTimer);
  }
  
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

console.log('========================================');
console.log('🚀 RVM AGENT - IMMEDIATE GATE CLOSURE');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('✅ Fixed: Gate closes immediately on session end');
console.log('✅ Parallel Compactor: Next bottle ready immediately!');
console.log('✅ Member: QR → Multiple items');
console.log('✅ Guest: No QR → Multiple items');
console.log('⚡ Time savings: ~20s per bottle');
console.log('========================================');
console.log('⏳ Starting...\n');

setTimeout(() => {
  if (state.moduleId) {
    state.isReady = true;
    console.log('🟢 SYSTEM READY\n');
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'ready',
      event: 'startup_ready',
      isReady: true,
      timestamp: new Date().toISOString()
    }));
  }
}, 3000);
