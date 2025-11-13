// agent-qr-serial.js - QR Reading via Serial/Keyboard Input (Like qr.html)
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const readline = require('readline');

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
      screenState: 'rvm/RVM-3101/screen/state'
    }
  },
  
  qr: {
    enabled: true,             // Enable QR scanning
    minLength: 5,              // Minimum QR code length
    maxLength: 50,             // Maximum QR code length
    scanTimeout: 200,          // Time between key presses (ms)
    serialPort: null,          // Optional: serial port for QR scanner
    useKeyboard: true          // Use keyboard input (like qr.html)
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
  
  // QR Scanner state (serial/keyboard input)
  qrBuffer: '',
  lastKeyTime: 0,
  qrScanTimer: null,
  processingQR: false,
  qrScannerEnabled: false,
  
  // Compactor tracking
  compactorRunning: false,
  compactorTimer: null,
  
  // Session tracking (MEMBER ONLY)
  sessionId: null,
  sessionCode: null,
  currentUserId: null,
  currentUserData: null,
  
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
// QR CODE SCANNER (SERIAL/KEYBOARD INPUT)
// ============================================

/**
 * Validate QR code with backend (MEMBER only)
 */
async function validateQRWithBackend(sessionCode) {
  try {
    console.log(`🔐 Validating QR code: ${sessionCode}`);
    
    const response = await axios.post(
      `${CONFIG.backend.url}/api/rvm/${CONFIG.device.id}/qr/validate`,
      { sessionCode },
      {
        timeout: CONFIG.backend.timeout,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    if (response.data.success) {
      console.log(`✅ QR validated - User: ${response.data.user.name}`);
      console.log(`📝 Session: ${response.data.session.sessionCode}`);
      return {
        valid: true,
        user: response.data.user,
        session: response.data.session
      };
    } else {
      console.log(`❌ QR validation failed: ${response.data.error}`);
      return {
        valid: false,
        error: response.data.error || 'Invalid QR code'
      };
    }
    
  } catch (error) {
    console.error('❌ QR validation error:', error.message);
    return {
      valid: false,
      error: error.response?.data?.error || error.message || 'Network error'
    };
  }
}

/**
 * Process QR code after scan complete
 */
async function processQRCode(qrData) {
  if (state.processingQR) {
    console.log('⏳ Already processing a QR code');
    return;
  }
  
  // Clean the QR data
  const cleanCode = qrData.replace(/[\r\n]/g, '').trim();
  
  // Validate format
  if (cleanCode.length < CONFIG.qr.minLength || cleanCode.length > CONFIG.qr.maxLength) {
    console.log(`❌ Invalid QR code length: ${cleanCode.length} chars`);
    console.log(`   Expected: ${CONFIG.qr.minLength}-${CONFIG.qr.maxLength} chars`);
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'qr_invalid',
      message: `Invalid QR code format (${cleanCode.length} chars)`,
      timestamp: new Date().toISOString()
    }));
    
    return;
  }
  
  state.processingQR = true;
  
  console.log('\n========================================');
  console.log('📱 QR CODE SCANNED');
  console.log('========================================');
  console.log(`QR Code: ${cleanCode}`);
  console.log(`Length: ${cleanCode.length} chars`);
  console.log('========================================\n');
  
  // Show scanning status on monitor
  mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
    deviceId: CONFIG.device.id,
    state: 'qr_validating',
    message: 'Validating QR code...',
    timestamp: new Date().toISOString()
  }));
  
  // Validate with backend
  const validation = await validateQRWithBackend(cleanCode);
  
  if (validation.valid) {
    console.log('\n✅ QR CODE VALID - STARTING MEMBER SESSION\n');
    
    // Show welcome on monitor
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'qr_validated',
      message: `Welcome ${validation.user.name}!`,
      user: validation.user,
      timestamp: new Date().toISOString()
    }));
    
    // Wait a moment to show welcome screen
    await delay(2000);
    
    // Start member session
    await startMemberSession(validation);
    
  } else {
    console.log('\n❌ QR CODE INVALID\n');
    console.log(`Error: ${validation.error}\n`);
    
    // Show error on monitor
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'qr_invalid',
      message: validation.error,
      timestamp: new Date().toISOString()
    }));
    
    // Wait 3 seconds then show scan screen again
    await delay(3000);
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'ready_for_qr',
      message: 'Please scan your QR code again',
      timestamp: new Date().toISOString()
    }));
  }
  
  state.processingQR = false;
}

/**
 * Handle keyboard input for QR scanner (like qr.html)
 */
function setupQRScanner() {
  if (!CONFIG.qr.enabled || !CONFIG.qr.useKeyboard) {
    console.log('⚠️ QR scanner disabled in config');
    return;
  }
  
  console.log('\n========================================');
  console.log('📱 QR SCANNER - KEYBOARD/SERIAL MODE');
  console.log('========================================');
  console.log('Waiting for QR scanner input...');
  console.log('QR scanners work like keyboards');
  console.log('========================================\n');
  
  state.qrScannerEnabled = true;
  
  // Setup readline interface for keyboard input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });
  
  // Listen for line input (Enter key sends the complete QR code)
  rl.on('line', (line) => {
    if (!state.isReady || state.autoCycleEnabled) {
      console.log('⚠️ System not ready for QR scan');
      return;
    }
    
    const qrCode = line.trim();
    
    if (qrCode.length >= CONFIG.qr.minLength) {
      console.log(`📱 QR Scanner Input: ${qrCode}`);
      processQRCode(qrCode);
    }
  });
  
  // Also listen to raw keypresses (for serial QR scanners)
  process.stdin.on('data', (data) => {
    if (!state.isReady || state.autoCycleEnabled || state.processingQR) {
      return;
    }
    
    const key = data.toString();
    const currentTime = Date.now();
    const timeDiff = currentTime - state.lastKeyTime;
    
    // Reset buffer if too much time between keypresses
    if (timeDiff > 100) {
      state.qrBuffer = '';
    }
    
    state.lastKeyTime = currentTime;
    
    // Check for Enter key (QR scanner sends Enter at end)
    if (key === '\n' || key === '\r' || key === '\r\n') {
      if (state.qrBuffer.length >= CONFIG.qr.minLength) {
        console.log(`📱 QR Complete: ${state.qrBuffer}`);
        const qrCode = state.qrBuffer;
        state.qrBuffer = '';
        processQRCode(qrCode);
      }
    } else {
      // Accumulate characters
      state.qrBuffer += key;
      
      // Clear timer if exists
      if (state.qrScanTimer) {
        clearTimeout(state.qrScanTimer);
      }
      
      // Set timer to process QR after timeout
      state.qrScanTimer = setTimeout(() => {
        if (state.qrBuffer.length >= CONFIG.qr.minLength) {
          console.log(`📱 QR Timeout: ${state.qrBuffer}`);
          const qrCode = state.qrBuffer;
          state.qrBuffer = '';
          processQRCode(qrCode);
        }
      }, CONFIG.qr.scanTimeout);
    }
  });
  
  console.log('✅ QR Scanner active - ready for input\n');
}

function stopQRScanner() {
  state.qrScannerEnabled = false;
  state.qrBuffer = '';
  if (state.qrScanTimer) {
    clearTimeout(state.qrScanTimer);
    state.qrScanTimer = null;
  }
  console.log('🛑 QR Scanner stopped\n');
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
// COMPACTOR MANAGEMENT
// ============================================
async function startCompactor() {
  if (state.compactorRunning) {
    console.log('⏳ Waiting for previous compactor cycle...');
    const startWait = Date.now();
    
    while (state.compactorRunning && (Date.now() - startWait) < CONFIG.timing.compactor + 5000) {
      await delay(500);
    }
    
    if (state.compactorRunning) {
      console.log('⚠️ Compactor timeout - forcing stop');
      await executeCommand('customMotor', CONFIG.motors.compactor.stop);
      state.compactorRunning = false;
    }
  }
  
  console.log('🎯 Step 5: Starting Compactor (parallel)');
  
  state.compactorRunning = true;
  await executeCommand('customMotor', CONFIG.motors.compactor.start);
  
  if (state.compactorTimer) {
    clearTimeout(state.compactorTimer);
  }
  
  state.compactorTimer = setTimeout(async () => {
    console.log('✅ Compactor finished');
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    state.compactorRunning = false;
    state.compactorTimer = null;
  }, CONFIG.timing.compactor);
  
  console.log(`⚡ Compactor running (${CONFIG.timing.compactor / 1000}s)\n`);
}

// ============================================
// REJECTION HANDLING
// ============================================
async function executeRejectionCycle() {
  console.log('\n========================================');
  console.log('❌ REJECTION CYCLE');
  console.log('========================================\n');

  try {
    console.log('🎯 Reversing belt to reject bin');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    console.log('✅ Item rejected\n');

    mqttClient.publish('rvm/RVM-3101/item/rejected', JSON.stringify({
      deviceId: CONFIG.device.id,
      reason: 'LOW_CONFIDENCE',
      userId: state.currentUserId,
      sessionCode: state.sessionCode,
      timestamp: new Date().toISOString()
    }));

  } catch (error) {
    console.error('❌ Rejection error:', error.message);
  }

  state.aiResult = null;
  state.weight = null;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  state.cycleInProgress = false;

  if (state.autoCycleEnabled) {
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    state.autoPhotoTimer = setTimeout(() => {
      if (!state.cycleInProgress && !state.awaitingDetection) {
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
  console.log('⏱️ SESSION TIMEOUT');
  console.log('========================================');
  console.log(`Reason: ${reason}`);
  console.log(`Items processed: ${state.itemsProcessed}`);
  console.log('========================================\n');
  
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
    timestamp: new Date().toISOString()
  }));
  
  if (state.cycleInProgress) {
    console.log('⏳ Waiting for current cycle...');
    const maxWait = 60000;
    const startWait = Date.now();
    
    while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
      await delay(1000);
    }
  }
  
  await resetSystemForNextUser(false);
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
// MEMBER SESSION MANAGEMENT
// ============================================
async function startMemberSession(validationData) {
  console.log('\n========================================');
  console.log('🎬 STARTING MEMBER SESSION');
  console.log('========================================');
  
  state.isReady = false;
  stopQRScanner();
  
  console.log(`👤 User: ${validationData.user.name}`);
  console.log(`🔑 Session: ${validationData.session.sessionCode}`);
  console.log(`💰 Current Points: ${validationData.user.currentPoints || 0}`);
  console.log('========================================\n');
  
  state.currentUserId = validationData.user.id;
  state.sessionId = validationData.session.sessionId;
  state.sessionCode = validationData.session.sessionCode;
  state.currentUserData = {
    name: validationData.user.name,
    email: validationData.user.email,
    currentPoints: validationData.user.currentPoints
  };
  
  state.autoCycleEnabled = true;
  state.itemsProcessed = 0;
  state.sessionStartTime = new Date();
  startSessionTimers();
  
  console.log('🔧 Resetting system...');
  await executeCommand('customMotor', CONFIG.motors.belt.stop);
  
  if (state.compactorRunning) {
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    if (state.compactorTimer) {
      clearTimeout(state.compactorTimer);
      state.compactorTimer = null;
    }
    state.compactorRunning = false;
  }
  
  await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
  await delay(2000);
  
  await executeCommand('calibrateWeight');
  await delay(1500);
  
  await executeCommand('openGate');
  await delay(CONFIG.timing.gateOperation);
  console.log('✅ Gate opened\n');
  
  // Show session active screen
  mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
    deviceId: CONFIG.device.id,
    state: 'session_active',
    message: 'Insert your items',
    user: {
      name: validationData.user.name,
      currentPoints: validationData.user.currentPoints
    },
    timestamp: new Date().toISOString()
  }));
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
  }
  
  state.autoPhotoTimer = setTimeout(() => {
    state.awaitingDetection = true;
    executeCommand('takePhoto');
  }, CONFIG.timing.autoPhotoDelay);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'session_active',
    event: 'session_started',
    sessionType: 'member',
    userId: state.currentUserId,
    sessionCode: state.sessionCode,
    timestamp: new Date().toISOString()
  }));
  
  console.log('✅ Member session started!\n');
}

async function resetSystemForNextUser(forceStop = false) {
  console.log('\n========================================');
  console.log('🔄 RESETTING FOR NEXT USER');
  console.log('========================================\n');
  
  if (state.resetting) {
    console.log('⚠️ Reset in progress\n');
    return;
  }
  
  state.resetting = true;
  
  if (state.cycleInProgress) {
    console.log('⏳ Waiting for cycle...');
    const maxWait = 60000;
    const startWait = Date.now();
    
    while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
      await delay(2000);
    }
  }
  
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  try {
    if (state.compactorRunning) {
      if (forceStop) {
        console.log('🚨 Force stopping compactor...');
        await executeCommand('customMotor', CONFIG.motors.compactor.stop);
        if (state.compactorTimer) {
          clearTimeout(state.compactorTimer);
          state.compactorTimer = null;
        }
        state.compactorRunning = false;
      } else {
        console.log('⏳ Waiting for compactor...');
        const maxWaitTime = CONFIG.timing.compactor + 2000;
        const startWait = Date.now();
        
        while (state.compactorRunning && (Date.now() - startWait) < maxWaitTime) {
          await delay(1000);
        }
        
        if (state.compactorRunning) {
          await executeCommand('customMotor', CONFIG.motors.compactor.stop);
          if (state.compactorTimer) {
            clearTimeout(state.compactorTimer);
            state.compactorTimer = null;
          }
          state.compactorRunning = false;
        }
      }
    }
    
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
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
  state.itemsProcessed = 0;
  state.sessionStartTime = null;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  
  clearSessionTimers();
  
  state.resetting = false;
  state.isReady = true;
  
  console.log('========================================');
  console.log('✅ SYSTEM READY');
  console.log('========================================\n');
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'ready',
    event: 'reset_complete',
    isReady: true,
    timestamp: new Date().toISOString()
  }));
  
  // Show scan QR screen
  mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
    deviceId: CONFIG.device.id,
    state: 'ready_for_qr',
    message: 'Please scan your QR code',
    timestamp: new Date().toISOString()
  }));
  
  // Restart QR scanner
  if (CONFIG.qr.enabled) {
    console.log('📱 QR Scanner ready for next member\n');
  }
}

// ============================================
// AUTO CYCLE PROCESSING
// ============================================
async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    state.cycleInProgress = false;
    return;
  }

  state.itemsProcessed++;
  
  const cycleData = {
    deviceId: CONFIG.device.id,
    material: state.aiResult.materialType,
    weight: state.weight.weight,
    userId: state.currentUserId,
    sessionCode: state.sessionCode,
    itemNumber: state.itemsProcessed,
    timestamp: new Date().toISOString()
  };
  
  console.log('\n========================================');
  console.log(`🤖 AUTO CYCLE - ITEM #${state.itemsProcessed}`);
  console.log('========================================\n');

  try {
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    const targetPosition = cycleData.material === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    await executeCommand('stepperMotor', { position: targetPosition });
    await delay(CONFIG.timing.stepperRotate);

    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);

    await startCompactor();

    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));

    resetInactivityTimer();

  } catch (error) {
    console.error('❌ Cycle error:', error.message);
  }

  state.aiResult = null;
  state.weight = null;
  state.cycleInProgress = false;
  state.detectionRetries = 0;
  state.awaitingDetection = false;

  if (state.autoCycleEnabled) {
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    state.autoPhotoTimer = setTimeout(() => {
      if (!state.cycleInProgress && !state.awaitingDetection) {
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
        
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        
        if (state.autoCycleEnabled && state.awaitingDetection) {
          if (state.aiResult.materialType !== 'UNKNOWN') {
            state.detectionRetries = 0;
            state.awaitingDetection = false;
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            state.detectionRetries++;
            
            if (state.detectionRetries < CONFIG.detection.maxRetries) {
              setTimeout(() => executeCommand('takePhoto'), CONFIG.detection.retryDelay);
            } else {
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
        
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));
        
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          setTimeout(async () => {
            await executeCommand('calibrateWeight');
            setTimeout(() => executeCommand('getWeight'), 1000);
          }, 500);
          return;
        }
        
        if (state.weight.weight > 0) state.calibrationAttempts = 0;
        
        if (state.autoCycleEnabled && state.aiResult && !state.cycleInProgress) {
          if (state.weight.weight < CONFIG.detection.minValidWeight) {
            state.aiResult = null;
            state.weight = null;
            state.awaitingDetection = false;
            
            if (state.autoPhotoTimer) {
              clearTimeout(state.autoPhotoTimer);
            }
            
            state.autoPhotoTimer = setTimeout(() => {
              if (!state.cycleInProgress && !state.awaitingDetection) {
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
      
    } catch (error) {
      console.error('❌ WS error:', error.message);
    }
  });
  
  state.ws.on('close', () => {
    console.log('⚠️ WS closed, reconnecting...');
    setTimeout(connectWebSocket, 5000);
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
    
    if (topic === CONFIG.mqtt.topics.commands) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (payload.action === 'emergencyStop') {
        stopQRScanner();
        await executeCommand('closeGate');
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        
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
        stopQRScanner();
        state.cycleInProgress = false;
        state.resetting = false;
        await resetSystemForNextUser(true);
        return;
      }
      
      if (payload.action === 'endSession') {
        stopQRScanner();
        await resetSystemForNextUser(false);
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
  
  stopQRScanner();
  
  if (state.compactorTimer) {
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
console.log('🚀 RVM AGENT - QR SERIAL INPUT');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('✅ Serial/Keyboard QR Scanner');
console.log('✅ Member Sessions Only');
console.log('✅ Multi-Item Support');
console.log('========================================\n');

setTimeout(() => {
  if (state.moduleId) {
    state.isReady = true;
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'ready',
      event: 'startup_ready',
      isReady: true,
      timestamp: new Date().toISOString()
    }));
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'ready_for_qr',
      message: 'Please scan your QR code',
      timestamp: new Date().toISOString()
    }));
    
    if (CONFIG.qr.enabled) {
      setupQRScanner();
    }
    
    console.log('🟢 SYSTEM READY FOR MEMBER QR SCAN\n');
  }
}, 3000);