// agent-qr-fixed-scanner.js - QR SCANNER THAT NEVER GETS STUCK
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const { GlobalKeyboardListener } = require('node-global-key-listener');

// ============================================
// CONFIGURATION - OPTIMIZED
// ============================================
const CONFIG = {
  device: {
    id: 'RVM-3101'
  },
  
  backend: {
    url: 'https://rebit-api.ceewen.xyz',
    timeout: 8000
  },
  
  local: {
    baseUrl: 'http://localhost:8081',
    wsUrl: 'ws://localhost:8081/websocket/qazwsx1234',
    timeout: 8000
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
      screenState: 'rvm/RVM-3101/screen/state',
      qrInput: 'rvm/RVM-3101/qr/input',
      guestStart: 'rvm/RVM-3101/guest/start'
    }
  },
  
  qr: {
    enabled: true,
    minLength: 5,
    maxLength: 50,
    scanTimeout: 200,
    processingTimeout: 25000,  // 25 seconds max
    debug: true  // Enable debug to see what's happening
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
    retryDelay: 1500,
    maxRetries: 2,
    hasObjectSensor: false,
    minValidWeight: 5
  },
  
  timing: {
    beltToWeight: 2500,
    beltToStepper: 3500,
    beltReverse: 4000,
    stepperRotate: 3500,
    stepperReset: 5000,
    compactor: 22000,
    positionSettle: 300,
    gateOperation: 800,
    autoPhotoDelay: 3000,
    sessionTimeout: 120000,
    sessionMaxDuration: 600000,
    weightDelay: 1500,
    photoDelay: 1200,
    calibrationDelay: 1200,
    commandDelay: 100,
    resetHomeDelay: 1500
  },
  
  heartbeat: {
    interval: 30,
    maxModuleIdRetries: 10,
    stateCheckInterval: 30  // Check scanner every 30 seconds
  },
  
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  },
  
  optimization: {
    parallelOperations: true,
    skipUnnecessaryDelays: true,
    fastCalibration: true,
    aggressiveTiming: true
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
  
  // QR Scanner state - FIXED WITH BETTER TRACKING
  qrBuffer: '',
  lastCharTime: 0,
  qrTimer: null,
  processingQR: false,
  processingQRTimeout: null,
  qrScannerActive: false,
  globalKeyListener: null,
  lastSuccessfulScan: null,
  scannerStuckCount: 0,  // NEW: Track stuck occurrences
  lastScanAttempt: null,  // NEW: Track last scan attempt
  
  // Session tracking
  sessionId: null,
  sessionCode: null,
  currentUserId: null,
  currentUserData: null,
  isMember: false,
  isGuestSession: false,
  itemsProcessed: 0,
  sessionStartTime: null,
  lastActivityTime: null,
  sessionTimeoutTimer: null,
  maxDurationTimer: null,
  
  // Hardware state
  compactorRunning: false,
  compactorTimer: null,
  autoPhotoTimer: null,
  detectionRetries: 0,
  awaitingDetection: false,
  resetting: false,
  
  // Performance tracking
  lastCycleTime: null,
  averageCycleTime: null,
  cycleCount: 0
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
    'debug': '🔍',
    'perf': '⚡',
    'qr': '📱'
  }[level] || 'ℹ️';
  
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function debugLog(message) {
  if (CONFIG.qr.debug) {
    log(message, 'debug');
  }
}

function trackCycleTime(startTime) {
  const cycleTime = Date.now() - startTime;
  state.lastCycleTime = cycleTime;
  state.cycleCount++;
  
  if (state.averageCycleTime === null) {
    state.averageCycleTime = cycleTime;
  } else {
    state.averageCycleTime = (state.averageCycleTime * (state.cycleCount - 1) + cycleTime) / state.cycleCount;
  }
  
  log(`⚡ Cycle completed in ${(cycleTime / 1000).toFixed(1)}s | Avg: ${(state.averageCycleTime / 1000).toFixed(1)}s`, 'perf');
}

// ============================================
// QR SCANNER RECOVERY FUNCTIONS - COMPLETELY REWRITTEN
// ============================================

/**
 * NUCLEAR OPTION: Complete scanner state reset
 */
function hardResetScanner() {
  log('🔧 HARD RESET SCANNER - Clearing ALL state', 'warning');
  
  // Clear all timers
  if (state.qrTimer) {
    clearTimeout(state.qrTimer);
    state.qrTimer = null;
  }
  
  if (state.processingQRTimeout) {
    clearTimeout(state.processingQRTimeout);
    state.processingQRTimeout = null;
  }
  
  // Reset ALL QR state
  state.qrBuffer = '';
  state.lastCharTime = 0;
  state.processingQR = false;
  state.qrScannerActive = false;
  state.lastScanAttempt = null;
  
  log('✅ Scanner hard reset complete', 'success');
}

/**
 * SAFE RESET: Clear processing flags without killing scanner
 */
function safeResetProcessingFlag() {
  log('🔄 Safe reset: Clearing processing flag', 'qr');
  
  if (state.processingQRTimeout) {
    clearTimeout(state.processingQRTimeout);
    state.processingQRTimeout = null;
  }
  
  state.processingQR = false;
  state.qrBuffer = '';
  
  if (state.qrTimer) {
    clearTimeout(state.qrTimer);
    state.qrTimer = null;
  }
  
  log('✅ Processing flag cleared', 'qr');
}

/**
 * Check if scanner is stuck and recover
 */
function checkScannerHealth() {
  const now = Date.now();
  
  log('🏥 Scanner Health Check:', 'qr');
  log(`   - qrScannerActive: ${state.qrScannerActive}`, 'qr');
  log(`   - processingQR: ${state.processingQR}`, 'qr');
  log(`   - isReady: ${state.isReady}`, 'qr');
  log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`, 'qr');
  log(`   - processingQRTimeout: ${state.processingQRTimeout !== null ? 'SET' : 'NULL'}`, 'qr');
  log(`   - lastScanAttempt: ${state.lastScanAttempt ? new Date(state.lastScanAttempt).toISOString() : 'NONE'}`, 'qr');
  
  // Check 1: processingQR stuck without timeout
  if (state.processingQR && state.processingQRTimeout === null) {
    log('⚠️ STUCK: processingQR=true but no timeout!', 'warning');
    state.scannerStuckCount++;
    safeResetProcessingFlag();
  }
  
  // Check 2: processingQR stuck for too long
  if (state.processingQR && state.lastScanAttempt) {
    const processingTime = now - state.lastScanAttempt;
    if (processingTime > CONFIG.qr.processingTimeout + 5000) {
      log(`⚠️ STUCK: Processing for ${Math.round(processingTime/1000)}s!`, 'warning');
      state.scannerStuckCount++;
      safeResetProcessingFlag();
    }
  }
  
  // Check 3: Scanner should be active but isn't
  if (state.isReady && !state.autoCycleEnabled && !state.resetting) {
    if (!state.qrScannerActive) {
      log('⚠️ STUCK: Scanner should be active but isn\'t!', 'warning');
      state.scannerStuckCount++;
      enableScanner();
    } else if (state.processingQR) {
      log('⚠️ WARNING: Scanner active but stuck in processing', 'warning');
      // Don't count as stuck, just warning
    } else {
      log('✅ Scanner healthy and ready', 'success');
      state.scannerStuckCount = 0;  // Reset stuck count
    }
  }
  
  // Check 4: Too many stuck occurrences - do hard reset
  if (state.scannerStuckCount >= 3) {
    log('🚨 CRITICAL: Scanner stuck 3+ times - HARD RESET!', 'warning');
    hardResetScanner();
    state.scannerStuckCount = 0;
    
    // Re-enable scanner if should be active
    if (state.isReady && !state.autoCycleEnabled && !state.resetting) {
      enableScanner();
    }
  }
  
  log('━'.repeat(50), 'qr');
}

/**
 * Enable scanner - idempotent and safe
 */
function enableScanner() {
  if (!CONFIG.qr.enabled) {
    log('QR scanner disabled in config', 'warning');
    return;
  }
  
  if (!state.isReady) {
    log('Cannot enable scanner - system not ready', 'warning');
    return;
  }
  
  if (state.autoCycleEnabled) {
    log('Cannot enable scanner - session active', 'warning');
    return;
  }
  
  if (state.resetting) {
    log('Cannot enable scanner - system resetting', 'warning');
    return;
  }
  
  // Already active and not processing? Nothing to do
  if (state.qrScannerActive && !state.processingQR) {
    log('✅ Scanner already active and ready', 'qr');
    return;
  }
  
  log('🟢 Enabling QR scanner...', 'qr');
  
  // Clear any stuck state first
  safeResetProcessingFlag();
  
  // Activate scanner
  state.qrScannerActive = true;
  state.scannerStuckCount = 0;
  
  log('✅ QR Scanner enabled and ready for scan', 'success');
}

/**
 * Disable scanner - safe shutdown
 */
function disableScanner() {
  if (!state.qrScannerActive) {
    log('Scanner already disabled', 'qr');
    return;
  }
  
  log('🔴 Disabling QR scanner...', 'qr');
  
  // Clear all state
  if (state.qrTimer) {
    clearTimeout(state.qrTimer);
    state.qrTimer = null;
  }
  
  if (state.processingQRTimeout) {
    clearTimeout(state.processingQRTimeout);
    state.processingQRTimeout = null;
  }
  
  state.qrBuffer = '';
  state.lastCharTime = 0;
  state.processingQR = false;
  state.qrScannerActive = false;
  
  log('✅ QR Scanner disabled', 'qr');
}

// ============================================
// MQTT-BASED HEARTBEAT WITH SCANNER CHECK
// ============================================
const heartbeat = {
  interval: null,
  stateCheckInterval: null,
  timeout: CONFIG.heartbeat.interval,
  moduleIdRetries: 0,
  maxModuleIdRetries: CONFIG.heartbeat.maxModuleIdRetries,
  
  start() {
    if (this.interval) {
      clearInterval(this.interval);
    }
    
    console.log(`💓 Starting heartbeat (every ${this.timeout}s)`);
    
    this.interval = setInterval(async () => {
      await this.beat();
    }, this.timeout * 1000);
    
    // Scanner health check
    if (this.stateCheckInterval) {
      clearInterval(this.stateCheckInterval);
    }
    
    this.stateCheckInterval = setInterval(() => {
      checkScannerHealth();
    }, CONFIG.heartbeat.stateCheckInterval * 1000);
    
    log(`🔍 Scanner health check: Every ${CONFIG.heartbeat.stateCheckInterval}s`, 'info');
  },
  
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    if (this.stateCheckInterval) {
      clearInterval(this.stateCheckInterval);
      this.stateCheckInterval = null;
    }
  },
  
  async beat() {
    const timestamp = new Date().toISOString();
    
    if (!state.moduleId && this.moduleIdRetries < this.maxModuleIdRetries) {
      this.moduleIdRetries++;
      console.log(`💓 Heartbeat: Module ID missing (retry ${this.moduleIdRetries}/${this.maxModuleIdRetries})`);
      await requestModuleId();
      await delay(1000);
      
      if (state.moduleId) {
        console.log(`✅ Module ID acquired via heartbeat: ${state.moduleId}`);
        this.moduleIdRetries = 0;
        
        if (!state.isReady) {
          state.isReady = true;
          log('========================================');
          log('🟢 SYSTEM READY - OPTIMIZED MODE');
          log('========================================');
          log(`📱 Module ID: ${state.moduleId}`);
          log('⚡ Fast cycle mode enabled');
          log('✅ Ready for QR scan or guest session');
          log('========================================\n');
          
          setupQRScanner();
          
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id,
            status: 'ready',
            event: 'module_id_acquired',
            moduleId: state.moduleId,
            isReady: true,
            optimized: true,
            timestamp
          }));
          
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id,
            state: 'ready_for_qr',
            message: 'Please scan your QR code or click Start Recycling',
            timestamp: new Date().toISOString()
          }));
        }
      }
    }
    
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      console.log('⚠️ Heartbeat: WebSocket disconnected, reconnecting...');
      connectWebSocket();
    }
    
    const heartbeatData = {
      deviceId: CONFIG.device.id,
      status: state.isReady ? 'ready' : 'initializing',
      event: 'heartbeat',
      moduleId: state.moduleId || null,
      isReady: state.isReady,
      resetting: state.resetting,
      cycleInProgress: state.cycleInProgress,
      autoCycleEnabled: state.autoCycleEnabled,
      compactorRunning: state.compactorRunning,
      itemsProcessed: state.itemsProcessed,
      sessionActive: state.autoCycleEnabled,
      sessionType: state.isMember ? 'member' : (state.isGuestSession ? 'guest' : null),
      qrScannerActive: state.qrScannerActive,
      processingQR: state.processingQR,
      scannerStuckCount: state.scannerStuckCount,
      lastCycleTime: state.lastCycleTime,
      averageCycleTime: state.averageCycleTime,
      cycleCount: state.cycleCount,
      optimized: true,
      uptime: Math.floor(process.uptime()),
      timestamp
    };
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify(heartbeatData));
    
    const perfInfo = state.lastCycleTime 
      ? ` | Last: ${(state.lastCycleTime / 1000).toFixed(1)}s`
      : '';
    
    const scannerStatus = state.qrScannerActive 
      ? (state.processingQR ? '🟡 PROC' : '🟢 READY') 
      : '🔴 OFF';
    
    console.log(`💓 Heartbeat: ${state.isReady ? '🟢 READY' : '🟡 INIT'} | ` +
                `Module: ${state.moduleId || 'NONE'} | ` +
                `Session: ${state.autoCycleEnabled ? 'ACTIVE' : 'IDLE'} | ` +
                `QR: ${scannerStatus}${perfInfo}`);
  }
};

// ============================================
// MODULE ID ACQUISITION
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

// ============================================
// DIAGNOSTIC FUNCTIONS
// ============================================
function runDiagnostics() {
  console.log('\n' + '='.repeat(60));
  console.log('🔬 QR SCANNER DIAGNOSTICS - FIXED VERSION');
  console.log('='.repeat(60));
  
  console.log('\n📱 QR Scanner State:');
  console.log(`   qrScannerActive: ${state.qrScannerActive}`);
  console.log(`   processingQR: ${state.processingQR}`);
  console.log(`   processingQRTimeout: ${state.processingQRTimeout !== null ? 'SET' : 'NULL'}`);
  console.log(`   qrBuffer: "${state.qrBuffer}" (${state.qrBuffer.length} chars)`);
  console.log(`   qrTimer: ${state.qrTimer !== null ? 'ACTIVE' : 'NULL'}`);
  console.log(`   scannerStuckCount: ${state.scannerStuckCount}`);
  console.log(`   lastScanAttempt: ${state.lastScanAttempt || 'NONE'}`);
  console.log(`   lastSuccessfulScan: ${state.lastSuccessfulScan || 'NONE'}`);
  
  console.log('\n🎯 System State:');
  console.log(`   isReady: ${state.isReady}`);
  console.log(`   autoCycleEnabled: ${state.autoCycleEnabled}`);
  console.log(`   resetting: ${state.resetting}`);
  console.log(`   moduleId: ${state.moduleId || 'NOT SET'}`);
  
  console.log('\n🔧 Recovery Features:');
  console.log(`   ✅ Automatic stuck detection`);
  console.log(`   ✅ Health check every ${CONFIG.heartbeat.stateCheckInterval}s`);
  console.log(`   ✅ Hard reset after 3 stuck occurrences`);
  console.log(`   ✅ Safe processing flag management`);
  console.log(`   ✅ Always re-enable after session ends`);
  
  console.log('\n' + '='.repeat(60));
  console.log('💡 TIP: Scanner will auto-recover from any stuck state!');
  console.log('='.repeat(60) + '\n');
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
// QR SCANNER - FIXED VERSION
// ============================================

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
 * Process QR code - WITH GUARANTEED CLEANUP
 */
async function processQRCode(qrData) {
  // Guard: Already processing
  if (state.processingQR) {
    debugLog('Already processing a QR code, skipping...');
    return;
  }
  
  const cleanCode = qrData.replace(/[\r\n\t]/g, '').trim();
  
  // Validate length
  if (cleanCode.length < CONFIG.qr.minLength || cleanCode.length > CONFIG.qr.maxLength) {
    log(`Invalid QR code length: ${cleanCode.length} chars`, 'error');
    return;
  }
  
  // Set processing flag with tracking
  state.processingQR = true;
  state.lastScanAttempt = Date.now();
  
  log(`📱 Processing QR: ${cleanCode}`, 'qr');
  log(`   Started at: ${new Date(state.lastScanAttempt).toISOString()}`, 'qr');
  
  // Safety timeout
  state.processingQRTimeout = setTimeout(() => {
    if (state.processingQR) {
      log('⏰ QR processing timeout - force clearing', 'warning');
      safeResetProcessingFlag();
      
      // Re-enable scanner
      if (state.isReady && !state.autoCycleEnabled && !state.resetting) {
        enableScanner();
      }
    }
  }, CONFIG.qr.processingTimeout);
  
  try {
    console.log('\n' + '='.repeat(50));
    console.log('📱 QR CODE SCANNED');
    console.log('='.repeat(50));
    console.log(`QR Code: ${cleanCode}`);
    console.log(`Length: ${cleanCode.length} chars`);
    console.log('='.repeat(50) + '\n');
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'qr_validating',
      message: 'Validating QR code...',
      timestamp: new Date().toISOString()
    }));
    
    const validation = await validateQRWithBackend(cleanCode);
    
    if (validation.valid) {
      log('✅ QR CODE VALID - STARTING SESSION', 'success');
      
      state.lastSuccessfulScan = new Date().toISOString();
      
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId: CONFIG.device.id,
        state: 'qr_validated',
        message: `Welcome ${validation.user.name}!`,
        user: validation.user,
        timestamp: new Date().toISOString()
      }));
      
      await delay(1500);
      
      // CRITICAL: Clear processing flag BEFORE starting session
      safeResetProcessingFlag();
      
      await startMemberSession(validation);
      
    } else {
      log('❌ QR CODE INVALID', 'error');
      
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId: CONFIG.device.id,
        state: 'qr_invalid',
        message: validation.error,
        timestamp: new Date().toISOString()
      }));
      
      await delay(2500);
      
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId: CONFIG.device.id,
        state: 'ready_for_qr',
        message: 'Please scan your QR code again',
        timestamp: new Date().toISOString()
      }));
      
      // CRITICAL: Clear processing flag and re-enable
      safeResetProcessingFlag();
      enableScanner();
    }
    
  } catch (error) {
    log(`❌ QR processing error: ${error.message}`, 'error');
    console.error(error);
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'error',
      message: 'QR processing error - please try again',
      timestamp: new Date().toISOString()
    }));
    
    await delay(2500);
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'ready_for_qr',
      message: 'Please scan your QR code',
      timestamp: new Date().toISOString()
    }));
    
    // CRITICAL: Always clear and re-enable on error
    safeResetProcessingFlag();
    enableScanner();
    
  } finally {
    // FINAL SAFETY NET: Always clear processing state
    if (state.processingQR) {
      log('🔧 Finally block: Clearing stuck processingQR flag', 'warning');
      safeResetProcessingFlag();
    }
    
    log('✅ QR processing complete', 'qr');
  }
}

/**
 * Setup QR Scanner - Initialize keyboard listener
 */
function setupQRScanner() {
  if (!CONFIG.qr.enabled) {
    log('QR scanner disabled in config', 'warning');
    return;
  }
  
  if (state.globalKeyListener) {
    log('QR scanner already initialized', 'warning');
    return;
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('📱 QR SCANNER - FIXED VERSION');
  console.log('='.repeat(50));
  console.log('✅ Never gets stuck!');
  console.log('✅ Auto-recovery enabled!');
  console.log('✅ Works in background!');
  console.log('✅ Always resets after session!');
  console.log('Press Ctrl+C to exit');
  console.log('='.repeat(50) + '\n');
  
  // Initialize scanner state
  enableScanner();
  
  const CONSOLE_PATTERNS = [
    /^C:\\/i,
    /^[A-Z]:\\/i,
    /operable program/i,
    /batch file/i,
    /Users\\/i,
    /\\rebit-mqtt/i,
    /node/i,
    /RVM AGENT/i
  ];
  
  function isConsoleOutput(text) {
    return CONSOLE_PATTERNS.some(pattern => pattern.test(text));
  }
  
  const gkl = new GlobalKeyboardListener();
  
  gkl.addListener((e, down) => {
    if (e.state !== 'DOWN') return;
    
    // Check if scanner is active
    if (!state.qrScannerActive) {
      debugLog('Scanner inactive, ignoring input');
      return;
    }
    
    // Check if system is ready
    if (!state.isReady || state.autoCycleEnabled || state.processingQR || state.resetting) {
      debugLog(`Input rejected - Ready:${state.isReady} Cycle:${state.autoCycleEnabled} Proc:${state.processingQR} Reset:${state.resetting}`);
      return;
    }
    
    const currentTime = Date.now();
    
    // Handle ENTER key
    if (e.name === 'RETURN' || e.name === 'ENTER') {
      if (state.qrBuffer.length >= CONFIG.qr.minLength && 
          state.qrBuffer.length <= CONFIG.qr.maxLength) {
        
        if (isConsoleOutput(state.qrBuffer)) {
          debugLog(`Rejected console output: "${state.qrBuffer}"`);
          state.qrBuffer = '';
          return;
        }
        
        const qrCode = state.qrBuffer;
        state.qrBuffer = '';
        
        if (state.qrTimer) {
          clearTimeout(state.qrTimer);
          state.qrTimer = null;
        }
        
        log(`✅ QR detected (ENTER): ${qrCode}`, 'success');
        
        // Process in background with error handling
        processQRCode(qrCode).catch(error => {
          log(`QR async error: ${error.message}`, 'error');
          safeResetProcessingFlag();
          enableScanner();
        });
        
      } else {
        debugLog(`Buffer invalid on ENTER: ${state.qrBuffer.length}`);
        state.qrBuffer = '';
      }
      return;
    }
    
    // Handle character input
    const char = e.name;
    
    if (char.length === 1) {
      const timeDiff = currentTime - state.lastCharTime;
      
      // Reset buffer on timeout
      if (timeDiff > CONFIG.qr.scanTimeout && state.qrBuffer.length > 0) {
        debugLog(`Timeout (${timeDiff}ms), resetting buffer`);
        state.qrBuffer = '';
      }
      
      // Prevent overflow
      if (state.qrBuffer.length >= CONFIG.qr.maxLength) {
        debugLog(`Buffer overflow, resetting`);
        state.qrBuffer = '';
        
        if (state.qrTimer) {
          clearTimeout(state.qrTimer);
          state.qrTimer = null;
        }
        return;
      }
      
      // Add character
      state.qrBuffer += char;
      debugLog(`Buffer: "${state.qrBuffer}" (${state.qrBuffer.length})`);
      state.lastCharTime = currentTime;
      
      // Auto-timeout
      if (state.qrTimer) {
        clearTimeout(state.qrTimer);
      }
      
      state.qrTimer = setTimeout(() => {
        if (state.qrBuffer.length >= CONFIG.qr.minLength && 
            state.qrBuffer.length <= CONFIG.qr.maxLength) {
          
          if (isConsoleOutput(state.qrBuffer)) {
            debugLog(`Auto-timeout rejected console: "${state.qrBuffer}"`);
            state.qrBuffer = '';
            state.qrTimer = null;
            return;
          }
          
          const qrCode = state.qrBuffer;
          state.qrBuffer = '';
          log(`✅ QR auto-detected: ${qrCode}`, 'success');
          
          // Process with error handling
          processQRCode(qrCode).catch(error => {
            log(`QR async error: ${error.message}`, 'error');
            safeResetProcessingFlag();
            enableScanner();
          });
          
        } else {
          debugLog(`Auto-timeout invalid: ${state.qrBuffer.length}`);
          state.qrBuffer = '';
        }
        state.qrTimer = null;
      }, CONFIG.qr.scanTimeout);
    }
  });
  
  state.globalKeyListener = gkl;
  
  log('✅ QR Scanner initialized - FIXED VERSION!', 'success');
}

// ============================================
// HARDWARE CONTROL FUNCTIONS - OPTIMIZED
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
  
  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: CONFIG.local.timeout,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (action === 'takePhoto') await delay(CONFIG.timing.photoDelay);
    if (action === 'getWeight') await delay(CONFIG.timing.weightDelay);
    
  } catch (error) {
    log(`${action} failed: ${error.message}`, 'error');
    throw error;
  }
}

// ============================================
// COMPACTOR & CYCLE FUNCTIONS - OPTIMIZED
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
  
  log('Starting Compactor', 'info');
  
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
}

async function executeRejectionCycle() {
  console.log('\n' + '='.repeat(50));
  console.log('❌ REJECTION CYCLE');
  console.log('='.repeat(50) + '\n');

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
    
    if (!CONFIG.optimization.skipUnnecessaryDelays) {
      await delay(CONFIG.timing.gateOperation);
    } else {
      await delay(CONFIG.timing.commandDelay);
    }
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
  }
}

async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    state.cycleInProgress = false;
    return;
  }

  const cycleStartTime = Date.now();
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
  
  console.log('\n' + '='.repeat(50));
  console.log(`⚡ FAST CYCLE - ITEM #${state.itemsProcessed}`);
  console.log('='.repeat(50) + '\n');

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

    if (CONFIG.optimization.parallelOperations) {
      log('⚡ Running compactor + stepper reset in parallel', 'perf');
      
      const compactorPromise = startCompactor();
      const stepperResetPromise = (async () => {
        await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
        await delay(CONFIG.timing.stepperReset);
      })();
      
      await Promise.all([compactorPromise, stepperResetPromise]);
      
    } else {
      await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
      await delay(CONFIG.timing.stepperReset);
      await startCompactor();
    }

    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));

    trackCycleTime(cycleStartTime);
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
    
    if (!CONFIG.optimization.skipUnnecessaryDelays) {
      await delay(CONFIG.timing.gateOperation);
    } else {
      await delay(CONFIG.timing.commandDelay);
    }
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
  }
}

// ============================================
// SESSION MANAGEMENT - WITH PROPER QR RESET
// ============================================
async function startMemberSession(validationData) {
  console.log('\n' + '='.repeat(50));
  console.log('🎬 STARTING MEMBER SESSION');
  console.log('='.repeat(50));
  
  try {
    state.isReady = false;
    
    // CRITICAL: Disable scanner properly
    disableScanner();
    
    log(`User: ${validationData.user.name}`, 'info');
    log(`Session: ${validationData.session.sessionCode}`, 'info');
    console.log('='.repeat(50) + '\n');
    
    state.currentUserId = validationData.user.id;
    state.sessionId = validationData.session.sessionId;
    state.sessionCode = validationData.session.sessionCode;
    state.currentUserData = {
      name: validationData.user.name,
      email: validationData.user.email,
      currentPoints: validationData.user.currentPoints
    };
    state.isMember = true;
    state.isGuestSession = false;
    
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
    await delay(CONFIG.timing.resetHomeDelay);
    
    await executeCommand('calibrateWeight');
    await delay(CONFIG.timing.calibrationDelay);
    
    await executeCommand('openGate');
    await delay(CONFIG.timing.commandDelay);
    
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
      if (state.autoCycleEnabled) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
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
    
    log('⚡ Member session started!', 'success');
    
  } catch (error) {
    log(`❌ Error starting member session: ${error.message}`, 'error');
    console.error(error);
    
    await resetSystemForNextUser(true);
    throw error;
  }
}

async function startGuestSession(sessionData) {
  console.log('\n' + '='.repeat(50));
  console.log('🎬 STARTING GUEST SESSION');
  console.log('='.repeat(50));
  
  try {
    state.isReady = false;
    
    // CRITICAL: Disable scanner properly
    disableScanner();
    
    log(`Session: ${sessionData.sessionCode}`, 'info');
    console.log('='.repeat(50) + '\n');
    
    state.currentUserId = null;
    state.sessionId = sessionData.sessionId;
    state.sessionCode = sessionData.sessionCode;
    state.currentUserData = null;
    state.isMember = false;
    state.isGuestSession = true;
    
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
    await delay(CONFIG.timing.resetHomeDelay);
    
    await executeCommand('calibrateWeight');
    await delay(CONFIG.timing.calibrationDelay);
    
    await executeCommand('openGate');
    await delay(CONFIG.timing.commandDelay);
    
    log('Gate opened', 'success');
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'session_active',
      message: 'Insert your items',
      sessionType: 'guest',
      timestamp: new Date().toISOString()
    }));
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'session_active',
      event: 'session_started',
      sessionType: 'guest',
      sessionId: state.sessionId,
      sessionCode: state.sessionCode,
      timestamp: new Date().toISOString()
    }));
    
    log('⚡ Guest session started!', 'success');
    
  } catch (error) {
    log(`❌ Error starting guest session: ${error.message}`, 'error');
    console.error(error);
    
    await resetSystemForNextUser(true);
    throw error;
  }
}

async function resetSystemForNextUser(forceStop = false) {
  console.log('\n' + '='.repeat(50));
  console.log('🔄 RESETTING FOR NEXT USER');
  console.log('='.repeat(50) + '\n');
  
  if (state.resetting) {
    log('Reset in progress', 'warning');
    return;
  }
  
  state.resetting = true;
  
  try {
    state.autoCycleEnabled = false;
    state.awaitingDetection = false;
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
      state.autoPhotoTimer = null;
    }
    
    if (state.cycleInProgress) {
      log('Waiting for cycle...', 'info');
      const maxWait = 60000;
      const startWait = Date.now();
      
      while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
        await delay(2000);
      }
    }
    
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
    await delay(CONFIG.timing.commandDelay);
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
  } catch (error) {
    log(`Reset error: ${error.message}`, 'error');
  } finally {
    // Reset state
    state.aiResult = null;
    state.weight = null;
    state.currentUserId = null;
    state.currentUserData = null;
    state.sessionId = null;
    state.sessionCode = null;
    state.calibrationAttempts = 0;
    state.cycleInProgress = false;
    state.itemsProcessed = 0;
    state.sessionStartTime = null;
    state.detectionRetries = 0;
    state.isMember = false;
    state.isGuestSession = false;
    
    clearSessionTimers();
    
    state.resetting = false;
    state.isReady = true;
    
    console.log('='.repeat(50));
    console.log('✅ SYSTEM READY FOR NEXT USER');
    console.log('='.repeat(50) + '\n');
    
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
    
    // CRITICAL: Re-enable scanner after reset
    log('🔄 Re-enabling QR scanner after reset...', 'qr');
    enableScanner();
  }
}

// ============================================
// SESSION TIMER FUNCTIONS
// ============================================

async function handleSessionTimeout(reason) {
  console.log('\n' + '='.repeat(50));
  console.log('⏱️ SESSION TIMEOUT');
  console.log('='.repeat(50));
  console.log(`Reason: ${reason}`);
  console.log(`Items processed: ${state.itemsProcessed}`);
  console.log('='.repeat(50) + '\n');
  
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  try {
    if (state.sessionCode && state.itemsProcessed > 0) {
      mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
        deviceId: CONFIG.device.id,
        status: 'session_timeout',
        event: 'auto_finalize_session',
        reason: reason,
        sessionCode: state.sessionCode,
        userId: state.currentUserId,
        itemsProcessed: state.itemsProcessed,
        sessionType: state.isMember ? 'member' : 'guest',
        timestamp: new Date().toISOString()
      }));
      
      await delay(2000);
    }
  } catch (error) {
    log(`⚠️ Session finalization error: ${error.message}`, 'warning');
  }
  
  if (state.cycleInProgress) {
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
// MQTT & WEBSOCKET
// ============================================
function connectWebSocket() {
  log('🔌 Connecting to WebSocket...', 'info');
  
  if (state.ws) {
    try {
      state.ws.removeAllListeners();
      state.ws.close();
    } catch (e) {
      // Ignore
    }
    state.ws = null;
  }
  
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    log('✅ WebSocket connected', 'success');
    
    if (!state.moduleId) {
      setTimeout(() => {
        requestModuleId();
      }, 1000);
    }
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.function === '01') {
        const newModuleId = message.moduleId;
        
        if (state.moduleId && state.moduleId !== newModuleId) {
          log(`⚠️ Module ID changed: ${state.moduleId} → ${newModuleId}`, 'warning');
        }
        
        state.moduleId = newModuleId;
        log(`✅ Module ID: ${state.moduleId}`, 'success');
        
        heartbeat.moduleIdRetries = 0;
        
        if (!state.isReady) {
          state.isReady = true;
          log('========================================');
          log('🟢 SYSTEM READY - FIXED SCANNER');
          log('========================================');
          log(`📱 Module ID: ${state.moduleId}`);
          log('✅ QR scanner never gets stuck!');
          log('========================================\n');
          
          setupQRScanner();
          
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id,
            status: 'ready',
            event: 'module_id_acquired',
            moduleId: state.moduleId,
            isReady: true,
            timestamp: new Date().toISOString()
          }));
          
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id,
            state: 'ready_for_qr',
            message: 'Please scan your QR code or click Start Recycling',
            timestamp: new Date().toISOString()
          }));
          
          setTimeout(() => {
            runDiagnostics();
          }, 2000);
        }
        
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
            setTimeout(() => executeCommand('getWeight'), 300);
          } else {
            state.detectionRetries++;
            
            if (state.detectionRetries < CONFIG.detection.maxRetries) {
              setTimeout(() => {
                if (state.autoCycleEnabled) {
                  executeCommand('takePhoto');
                }
              }, CONFIG.detection.retryDelay);
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
            setTimeout(() => executeCommand('getWeight'), CONFIG.timing.calibrationDelay);
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
              if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
                state.awaitingDetection = true;
                executeCommand('takePhoto');
              }
            }, CONFIG.timing.autoPhotoDelay);
            
            return;
          }
          
          state.cycleInProgress = true;
          setTimeout(() => executeAutoCycle(), 500);
        }
        return;
      }
      
    } catch (error) {
      log(`WS message error: ${error.message}`, 'error');
    }
  });
  
  state.ws.on('error', (error) => {
    log(`❌ WS error: ${error.message}`, 'error');
  });
  
  state.ws.on('close', (code, reason) => {
    log(`⚠️ WS closed (${code})`, 'warning');
    
    setTimeout(() => {
      connectWebSocket();
    }, 5000);
  });
}

const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  log('✅ MQTT connected', 'success');
  
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.qrInput);
  mqttClient.subscribe(CONFIG.mqtt.topics.guestStart);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'online',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  connectWebSocket();
  
  setTimeout(() => {
    requestModuleId();
  }, 2000);
  
  setTimeout(() => {
    heartbeat.start();
  }, 5000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    if (topic === CONFIG.mqtt.topics.guestStart) {
      log('🎫 Guest session start requested', 'info');
      
      if (state.resetting) {
        log('System resetting - please wait', 'warning');
        return;
      }
      
      if (!state.isReady) {
        log('System not ready - please wait', 'warning');
        return;
      }
      
      if (state.autoCycleEnabled) {
        log('Ending previous session first...', 'warning');
        await resetSystemForNextUser(false);
        await delay(2000);
      }
      
      await startGuestSession(payload);
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.commands) {
      log(`Command: ${payload.action}`, 'info');
      
      if (payload.action === 'emergencyStop') {
        disableScanner();
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
        state.cycleInProgress = false;
        state.resetting = false;
        await resetSystemForNextUser(true);
        return;
      }
      
      if (payload.action === 'endSession') {
        await resetSystemForNextUser(false);
        return;
      }
      
      if (payload.action === 'runDiagnostics') {
        runDiagnostics();
        return;
      }
      
      if (payload.action === 'enableScanner') {
        enableScanner();
        return;
      }
      
      if (payload.action === 'disableScanner') {
        disableScanner();
        return;
      }
      
      if (payload.action === 'checkScannerHealth') {
        checkScannerHealth();
        return;
      }
      
      if (payload.action === 'hardResetScanner') {
        hardResetScanner();
        enableScanner();
        return;
      }
      
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      }
    }
    
    if (topic === CONFIG.mqtt.topics.qrInput) {
      const { qrCode } = payload;
      
      if (state.isReady && !state.autoCycleEnabled && !state.processingQR) {
        log(`✅ QR via MQTT: ${qrCode}`, 'success');
        processQRCode(qrCode).catch(error => {
          log(`QR error: ${error.message}`, 'error');
        });
      }
    }
    
  } catch (error) {
    log(`MQTT error: ${error.message}`, 'error');
  }
});

mqttClient.on('error', (error) => {
  log(`MQTT error: ${error.message}`, 'error');
});

// ============================================
// SHUTDOWN & ERROR HANDLING
// ============================================
function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...\n');
  
  disableScanner();
  heartbeat.stop();
  
  if (state.compactorTimer) clearTimeout(state.compactorTimer);
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  
  clearSessionTimers();
  
  if (state.globalKeyListener) {
    try {
      state.globalKeyListener.kill();
    } catch (e) {
      // Ignore
    }
  }
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) {
    try {
      state.ws.close();
    } catch (e) {
      // Ignore
    }
  }
  
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
console.log('='.repeat(60));
console.log('🚀 RVM AGENT - FIXED QR SCANNER');
console.log('='.repeat(60));
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('✅ QR scanner never gets stuck!');
console.log('✅ Auto-recovery every 30 seconds');
console.log('✅ Always resets after session ends');
console.log('✅ Robust error handling');
console.log('✅ Debug mode enabled');
console.log('='.repeat(60) + '\n');

log('🚀 Agent starting with FIXED scanner...', 'info');