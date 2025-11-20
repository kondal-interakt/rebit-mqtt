// agent-qr-serial-fixed.js - IMPROVED QR Reading with Better Debugging
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
      screenState: 'rvm/RVM-3101/screen/state'
    }
  },
  
  qr: {
    enabled: true,
    minLength: 5,
    maxLength: 50,
    scanTimeout: 500,        // Increased from 300ms
    serialPort: null,
    useKeyboard: true,
    debug: true,             // Keep debug ON for troubleshooting
    testMode: false          // NEW: Enable test mode for manual testing
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
  
  // QR Scanner state
  qrBuffer: '',
  lastKeyTime: 0,
  qrScanTimer: null,
  processingQR: false,
  qrScannerEnabled: false,
  stdinConfigured: false,
  stdinListener: null,        // NEW: Track listener reference
  
  // Compactor tracking
  compactorRunning: false,
  compactorTimer: null,
  
  // Session tracking
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
  detectionRetries: 0,
  maxDetectionRetries: 3,
  awaitingDetection: false,
  resetting: false
};

// ============================================
// UTILITY FUNCTIONS
// ============================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = {
    'info': 'ℹ️',
    'success': '✅',
    'error': '❌',
    'warning': '⚠️',
    'debug': '🔍'
  }[level] || 'ℹ️';
  
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function debugLog(message) {
  if (CONFIG.qr.debug) {
    log(message, 'debug');
  }
}

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
      log(`${materialType} detected via keyword match (${confidencePercent}% confidence, relaxed threshold)`, 'success');
      return materialType;
    }
    
    log(`${materialType} detected but confidence too low (${confidencePercent}% < ${thresholdPercent}%)`, 'warning');
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN') {
    log(`${materialType} detected (${confidencePercent}%)`, 'success');
  }
  
  return materialType;
}

// ============================================
// QR CODE SCANNER (IMPROVED)
// ============================================

/**
 * Validate QR code with backend
 */
async function validateQRWithBackend(sessionCode) {
  try {
    log(`Validating QR code: ${sessionCode}`, 'info');
    
    const response = await axios.post(
      `${CONFIG.backend.url}/api/rvm/${CONFIG.device.id}/qr/validate`,
      { sessionCode },
      {
        timeout: CONFIG.backend.timeout,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    if (response.data.success) {
      log(`QR validated - User: ${response.data.user.name}`, 'success');
      log(`Session: ${response.data.session.sessionCode}`, 'info');
      return {
        valid: true,
        user: response.data.user,
        session: response.data.session
      };
    } else {
      log(`QR validation failed: ${response.data.error}`, 'error');
      return {
        valid: false,
        error: response.data.error || 'Invalid QR code'
      };
    }
    
  } catch (error) {
    log(`QR validation error: ${error.message}`, 'error');
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
    log('Already processing a QR code', 'warning');
    return;
  }
  
  const cleanCode = qrData.replace(/[\r\n\t]/g, '').trim();
  
  if (cleanCode.length < CONFIG.qr.minLength || cleanCode.length > CONFIG.qr.maxLength) {
    log(`Invalid QR code length: ${cleanCode.length} chars (expected: ${CONFIG.qr.minLength}-${CONFIG.qr.maxLength})`, 'error');
    
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
  
  mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
    deviceId: CONFIG.device.id,
    state: 'qr_validating',
    message: 'Validating QR code...',
    timestamp: new Date().toISOString()
  }));
  
  const validation = await validateQRWithBackend(cleanCode);
  
  if (validation.valid) {
    log('QR CODE VALID - STARTING MEMBER SESSION', 'success');
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'qr_validated',
      message: `Welcome ${validation.user.name}!`,
      user: validation.user,
      timestamp: new Date().toISOString()
    }));
    
    await delay(2000);
    await startMemberSession(validation);
    
  } else {
    log('QR CODE INVALID', 'error');
    log(`Error: ${validation.error}`, 'error');
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'qr_invalid',
      message: validation.error,
      timestamp: new Date().toISOString()
    }));
    
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
 * IMPROVED: Handle keyboard/serial input for QR scanner
 */
function setupQRScanner() {
  if (!CONFIG.qr.enabled || !CONFIG.qr.useKeyboard) {
    log('QR scanner disabled in config', 'warning');
    return;
  }
  
  if (state.stdinConfigured) {
    log('QR scanner already configured', 'warning');
    return;
  }
  
  console.log('\n========================================');
  console.log('📱 QR SCANNER - KEYBOARD/SERIAL MODE');
  console.log('========================================');
  console.log('Waiting for QR scanner input...');
  console.log('QR scanners work like keyboards');
  console.log('Press Ctrl+C to exit');
  console.log('========================================');
  console.log(`🔍 stdin.isTTY: ${process.stdin.isTTY}`);
  console.log(`🔍 stdin.isRaw: ${process.stdin.isRaw}`);
  console.log(`🔍 stdin.readable: ${process.stdin.readable}`);
  console.log(`🔍 stdin.readableFlowing: ${process.stdin.readableFlowing}`);
  console.log('========================================\n');
  
  state.qrScannerEnabled = true;
  state.qrBuffer = '';
  state.lastKeyTime = Date.now();
  
  // Configure stdin
  try {
    // Check for existing listeners
    const existingListeners = process.stdin.listenerCount('data');
    if (existingListeners > 0) {
      log(`⚠️ Found ${existingListeners} existing stdin listeners, removing...`, 'warning');
      process.stdin.removeAllListeners('data');
    }
    
    // IMPORTANT: Resume BEFORE setting raw mode
    if (!process.stdin.readable) {
      log('⚠️ stdin not readable!', 'error');
    }
    
    process.stdin.resume();
    log('✅ stdin resumed', 'success');
    
    // Set encoding
    process.stdin.setEncoding('utf8');
    log('✅ stdin encoding set to utf8', 'success');
    
    // Set raw mode if TTY
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
        log('✅ stdin set to raw mode', 'success');
      } catch (rawModeError) {
        log(`⚠️ Could not set raw mode: ${rawModeError.message}`, 'warning');
        log('Continuing without raw mode (OK for QR scanners)', 'info');
      }
    } else {
      log('ℹ️ stdin is not a TTY (OK for QR scanners)', 'info');
    }
    
    state.stdinConfigured = true;
    log('✅ stdin configuration complete', 'success');
    
  } catch (error) {
    log(`❌ Failed to configure stdin: ${error.message}`, 'error');
    console.error(error.stack);
    return;
  }
  
  // Create and attach the data handler
  state.stdinListener = (chunk) => handleStdinData(chunk);
  process.stdin.on('data', state.stdinListener);
  
  log('✅ QR Scanner active - ready for input', 'success');
  
  // Test prompt
  if (CONFIG.qr.testMode) {
    console.log('\n💡 TEST MODE: Type a code (min 5 chars) and press Enter');
    console.log('💡 Or paste a QR code value\n');
  }
  
  // Log stdin status
  console.log(`📊 stdin status:`);
  console.log(`   - readableFlowing: ${process.stdin.readableFlowing}`);
  console.log(`   - data listeners: ${process.stdin.listenerCount('data')}`);
  console.log(`   - readable: ${process.stdin.readable}`);
  console.log('');
}

/**
 * NEW: Separate handler for stdin data
 */
function handleStdinData(chunk) {
  try {
    // Handle Ctrl+C
    if (chunk === '\u0003') {
      log('Ctrl+C detected, shutting down...', 'info');
      gracefulShutdown();
      return;
    }
    
    // Debug raw input
    debugLog(`Raw input: ${JSON.stringify(chunk)} (${chunk.length} bytes)`);
    
    // Check if scanner is enabled
    if (!state.qrScannerEnabled) {
      debugLog('QR scanner disabled, ignoring input');
      return;
    }
    
    if (state.processingQR) {
      debugLog('Already processing QR, ignoring input');
      return;
    }
    
    if (!state.isReady) {
      log('System not ready for QR scan', 'warning');
      return;
    }
    
    if (state.autoCycleEnabled) {
      log('Session already active, ignoring QR scan', 'warning');
      return;
    }
    
    const currentTime = Date.now();
    const timeDiff = currentTime - state.lastKeyTime;
    
    // Reset buffer if timeout exceeded (new scan starting)
    if (timeDiff > CONFIG.qr.scanTimeout) {
      if (state.qrBuffer.length > 0) {
        debugLog(`Buffer reset: timeout ${timeDiff}ms (had ${state.qrBuffer.length} chars)`);
      }
      state.qrBuffer = '';
    }
    
    state.lastKeyTime = currentTime;
    
    // Process each character
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i];
      const charCode = char.charCodeAt(0);
      
      debugLog(`Processing char[${i}]: '${char}' (code: ${charCode})`);
      
      // Check for Enter/Return
      if (char === '\n' || char === '\r') {
        debugLog('Enter/Return detected');
        
        // Skip if we just processed an Enter (handles \r\n)
        if (state.qrBuffer === '' && i === 0) {
          debugLog('Empty buffer with Enter, skipping');
          continue;
        }
        
        if (state.qrBuffer.length >= CONFIG.qr.minLength) {
          const qrCode = state.qrBuffer.trim();
          log(`✅ QR Code Complete: "${qrCode}" (${qrCode.length} chars)`, 'success');
          
          // Clear buffer and timer
          state.qrBuffer = '';
          if (state.qrScanTimer) {
            clearTimeout(state.qrScanTimer);
            state.qrScanTimer = null;
          }
          
          // Process the QR code
          processQRCode(qrCode);
          return;
          
        } else if (state.qrBuffer.length > 0) {
          log(`⚠️ QR too short: ${state.qrBuffer.length} chars (min: ${CONFIG.qr.minLength})`, 'warning');
          state.qrBuffer = '';
        }
      }
      // Accept printable ASCII
      else if (charCode >= 32 && charCode <= 126) {
        state.qrBuffer += char;
        
        // Progress indicator
        if (state.qrBuffer.length === 1) {
          process.stdout.write('📱 Scanning');
        }
        if (state.qrBuffer.length % 5 === 0) {
          process.stdout.write('.');
        }
        
        debugLog(`Buffer now: "${state.qrBuffer}" (${state.qrBuffer.length} chars)`);
        
        // Auto-process if max length reached
        if (state.qrBuffer.length >= CONFIG.qr.maxLength) {
          const qrCode = state.qrBuffer.trim();
          log(`\n✅ QR Max Length: "${qrCode}"`, 'success');
          
          state.qrBuffer = '';
          if (state.qrScanTimer) {
            clearTimeout(state.qrScanTimer);
            state.qrScanTimer = null;
          }
          
          processQRCode(qrCode);
          return;
        }
      }
      // Ignore non-printable
      else {
        debugLog(`Ignoring non-printable char: ${charCode}`);
      }
    }
    
    // Set/reset timeout timer
    if (state.qrScanTimer) {
      clearTimeout(state.qrScanTimer);
    }
    
    if (state.qrBuffer.length > 0) {
      state.qrScanTimer = setTimeout(() => {
        if (state.qrBuffer.length >= CONFIG.qr.minLength) {
          const qrCode = state.qrBuffer.trim();
          log(`\n✅ QR Timeout Complete: "${qrCode}"`, 'success');
          state.qrBuffer = '';
          processQRCode(qrCode);
        } else {
          log(`\n⚠️ Incomplete scan cleared: "${state.qrBuffer}" (${state.qrBuffer.length} chars)`, 'warning');
          state.qrBuffer = '';
        }
        state.qrScanTimer = null;
      }, CONFIG.qr.scanTimeout);
      
      debugLog(`Timeout set for ${CONFIG.qr.scanTimeout}ms`);
    }
    
  } catch (error) {
    log(`❌ Error in QR scanner: ${error.message}`, 'error');
    console.error(error.stack);
  }
}

function stopQRScanner() {
  log('Stopping QR scanner...', 'info');
  
  state.qrScannerEnabled = false;
  state.qrBuffer = '';
  
  if (state.qrScanTimer) {
    clearTimeout(state.qrScanTimer);
    state.qrScanTimer = null;
  }
  
  // Remove listener
  if (state.stdinConfigured && state.stdinListener) {
    process.stdin.removeListener('data', state.stdinListener);
    state.stdinListener = null;
    debugLog('Removed stdin data listener');
  }
  
  // Restore normal mode
  if (state.stdinConfigured) {
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try {
        process.stdin.setRawMode(false);
        debugLog('stdin raw mode disabled');
      } catch (error) {
        log(`Error restoring stdin: ${error.message}`, 'error');
      }
    }
    
    // Pause stdin
    try {
      process.stdin.pause();
      debugLog('stdin paused');
    } catch (error) {
      log(`Error pausing stdin: ${error.message}`, 'error');
    }
    
    state.stdinConfigured = false;
  }
  
  log('QR Scanner stopped', 'success');
}

// ============================================
// HARDWARE CONTROL (unchanged)
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
  
  debugLog(`Executing: ${action} ${JSON.stringify(apiPayload)}`);
  
  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: CONFIG.local.timeout,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (action === 'takePhoto') await delay(1500);
    if (action === 'getWeight') await delay(2000);
    
  } catch (error) {
    log(`${action} failed: ${error.message}`, 'error');
    throw error;
  }
}

// ============================================
// COMPACTOR, SESSION, CYCLE LOGIC (unchanged)
// ============================================
async function startCompactor() {
  if (state.compactorRunning) {
    log('Waiting for previous compactor cycle...', 'warning');
    const startWait = Date.now();
    
    while (state.compactorRunning && (Date.now() - startWait) < CONFIG.timing.compactor + 5000) {
      await delay(500);
    }
    
    if (state.compactorRunning) {
      log('Compactor timeout - forcing stop', 'warning');
      await executeCommand('customMotor', CONFIG.motors.compactor.stop);
      state.compactorRunning = false;
    }
  }
  
  log('Step 5: Starting Compactor (parallel)', 'info');
  
  state.compactorRunning = true;
  await executeCommand('customMotor', CONFIG.motors.compactor.start);
  
  if (state.compactorTimer) {
    clearTimeout(state.compactorTimer);
  }
  
  state.compactorTimer = setTimeout(async () => {
    log('Compactor finished', 'success');
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    state.compactorRunning = false;
    state.compactorTimer = null;
  }, CONFIG.timing.compactor);
  
  log(`Compactor running (${CONFIG.timing.compactor / 1000}s)`, 'info');
}

async function executeRejectionCycle() {
  console.log('\n========================================');
  console.log('❌ REJECTION CYCLE');
  console.log('========================================\n');

  try {
    log('Reversing belt to reject bin', 'info');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    log('Item rejected', 'success');

    mqttClient.publish('rvm/RVM-3101/item/rejected', JSON.stringify({
      deviceId: CONFIG.device.id,
      reason: 'LOW_CONFIDENCE',
      userId: state.currentUserId,
      sessionCode: state.sessionCode,
      timestamp: new Date().toISOString()
    }));

  } catch (error) {
    log(`Rejection error: ${error.message}`, 'error');
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
    log('Waiting for current cycle...', 'info');
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

async function startMemberSession(validationData) {
  console.log('\n========================================');
  console.log('🎬 STARTING MEMBER SESSION');
  console.log('========================================');
  
  state.isReady = false;
  stopQRScanner();
  
  log(`User: ${validationData.user.name}`, 'info');
  log(`Session: ${validationData.session.sessionCode}`, 'info');
  log(`Current Points: ${validationData.user.currentPoints || 0}`, 'info');
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
  
  log('Resetting system...', 'info');
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
  log('Gate opened', 'success');
  
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
  
  log('Member session started!', 'success');
}

async function resetSystemForNextUser(forceStop = false) {
  console.log('\n========================================');
  console.log('🔄 RESETTING FOR NEXT USER');
  console.log('========================================\n');
  
  if (state.resetting) {
    log('Reset in progress', 'warning');
    return;
  }
  
  state.resetting = true;
  
  if (state.cycleInProgress) {
    log('Waiting for cycle...', 'info');
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
        log('Force stopping compactor...', 'warning');
        await executeCommand('customMotor', CONFIG.motors.compactor.stop);
        if (state.compactorTimer) {
          clearTimeout(state.compactorTimer);
          state.compactorTimer = null;
        }
        state.compactorRunning = false;
      } else {
        log('Waiting for compactor...', 'info');
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
    log(`Reset error: ${error.message}`, 'error');
  }
  
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
  
  mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
    deviceId: CONFIG.device.id,
    state: 'ready_for_qr',
    message: 'Please scan your QR code',
    timestamp: new Date().toISOString()
  }));
  
  if (CONFIG.qr.enabled) {
    setupQRScanner();
    log('QR Scanner ready for next member', 'success');
  }
}

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
    log(`Cycle error: ${error.message}`, 'error');
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
// WEBSOCKET & MQTT (unchanged)
// ============================================
function connectWebSocket() {
  log('Connecting to WebSocket...', 'info');
  
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    log('WebSocket connected', 'success');
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.function === '01') {
        state.moduleId = message.moduleId;
        log(`Module ID: ${state.moduleId}`, 'success');
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
      log(`WS error: ${error.message}`, 'error');
    }
  });
  
  state.ws.on('error', (error) => {
    log(`WS connection error: ${error.message}`, 'error');
  });
  
  state.ws.on('close', () => {
    log('WS closed, reconnecting in 5s...', 'warning');
    setTimeout(connectWebSocket, 5000);
  });
}

const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  log('MQTT connected', 'success');
  
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
      log(`Command: ${payload.action}`, 'info');
      
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
    log(`MQTT error: ${error.message}`, 'error');
  }
});

mqttClient.on('error', (error) => {
  log(`MQTT connection error: ${error.message}`, 'error');
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
    log(`Module ID request failed: ${error.message}`, 'error');
  }
}

function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...\n');
  
  stopQRScanner();
  
  if (state.compactorTimer) {
    clearTimeout(state.compactorTimer);
  }
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
  }
  
  clearSessionTimers();
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) state.ws.close();
  
  setTimeout(() => {
    mqttClient.end();
    log('Shutdown complete', 'success');
    process.exit(0);
  }, 1000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

process.on('uncaughtException', (error) => {
  log(`Uncaught exception: ${error.message}`, 'error');
  console.error(error);
  gracefulShutdown();
});

process.on('unhandledRejection', (error) => {
  log(`Unhandled rejection: ${error.message}`, 'error');
  console.error(error);
});

// ============================================
// STARTUP
// ============================================
console.log('========================================');
console.log('🚀 RVM AGENT - QR SERIAL (FIXED v2)');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('✅ Improved Serial/Keyboard QR Scanner');
console.log('✅ Better stdin handling');
console.log('✅ Enhanced debugging');
console.log(`🔍 Debug Mode: ${CONFIG.qr.debug ? 'ON' : 'OFF'}`);
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
  } else {
    log('Module ID not received, retrying...', 'warning');
    requestModuleId();
  }
}, 3000);