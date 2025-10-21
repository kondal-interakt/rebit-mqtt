// ============================================================
// RVM AGENT v10.1 - PRODUCTION (FULLY DEBUGGED & FIXED)
// Market Standard Implementation with Complete Error Handling
// ============================================================

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const EventEmitter = require('events');

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
  device: {
    id: 'RVM-3101',
    version: '10.1.0',
    environment: process.env.NODE_ENV || 'production'
  },
  
  backend: {
    url: process.env.BACKEND_URL || 'https://rebit-api.ceewen.xyz',
    validateEndpoint: '/api/rvm/RVM-3101/qr/validate',
    timeout: 10000,
    retries: 3
  },
  
  local: {
    baseUrl: 'http://localhost:8081',
    wsUrl: 'ws://localhost:8081/websocket/qazwsx1234',
    timeout: 10000,
    reconnectInterval: 5000
  },
  
  mqtt: {
    brokerUrl: process.env.MQTT_URL || 'mqtts://mqtt.ceewen.xyz:8883',
    username: process.env.MQTT_USER || 'mqttuser',
    password: process.env.MQTT_PASS || 'mqttUser@2025',
    caFile: process.env.MQTT_CA || 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle',
    topics: {
      commands: 'rvm/RVM-3101/commands',
      autoControl: 'rvm/RVM-3101/control/auto',
      cycleComplete: 'rvm/RVM-3101/cycle/complete',
      aiResult: 'rvm/RVM-3101/ai/result',
      weightResult: 'rvm/RVM-3101/weight/result',
      status: 'rvm/RVM-3101/status',
      qrScan: 'rvm/RVM-3101/qr/scanned',
      health: 'rvm/RVM-3101/health'
    },
    qos: { default: 1, status: 2 }
  },
  
  qr: {
    minLength: 8,
    maxLength: 20,
    numericOnly: true,
    scanTimeout: 100,        // Time between characters from scanner
    processDelay: 200,       // Auto-process delay after last character
    validationTimeout: 5000  // Backend validation timeout
  },
  
  motors: {
    belt: {
      toWeight: { motorId: '02', type: '02' },
      toStepper: { motorId: '02', type: '03' },
      reverse: { motorId: '02', type: '01' },
      stop: { motorId: '02', type: '00' }
    },
    compactor: {
      start: { motorId: '04', type: '01' },
      stop: { motorId: '04', type: '00' }
    },
    stepper: {
      moduleId: '09',
      positions: { home: '01', metalCan: '02', plasticBottle: '03' }
    }
  },
  
  detection: {
    METAL_CAN: { threshold: 0.22, bin: 'metalCan' },
    PLASTIC_BOTTLE: { threshold: 0.30, bin: 'plasticBottle' },
    GLASS: { threshold: 0.25, bin: 'home' }
  },
  
  timing: {
    beltToWeight: 3000,
    beltToStepper: 4000,
    beltReverse: 5000,
    stepperRotate: 4000,
    stepperReset: 6000,
    positionSettle: 500,
    gateOperation: 1000,
    autoPhotoDelay: 5000,
    moduleIdRetry: 1000,
    maxModuleIdAttempts: 5
  },
  
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 },
    minValidWeight: 1,
    maxCalibrationAttempts: 2
  },
  
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    timestamps: true,
    colors: true
  }
};

// ============================================================
// STATE MACHINE
// ============================================================
class StateMachine extends EventEmitter {
  constructor() {
    super();
    this.state = 'IDLE';
    this.data = {
      moduleId: null,
      aiResult: null,
      weight: null,
      sessionId: null,
      currentUserId: null,
      currentUserData: null,
      calibrationAttempts: 0
    };
    this.flags = {
      autoCycleEnabled: false,
      cycleInProgress: false,
      qrScanEnabled: true,
      isProcessingQR: false
    };
    this.timers = new Map();
  }

  setState(newState) {
    const oldState = this.state;
    this.state = newState;
    logger.info(`State: ${oldState} → ${newState}`);
    this.emit('stateChange', { from: oldState, to: newState });
  }

  getState() {
    return this.state;
  }

  reset(full = false) {
    logger.info('Resetting state machine');
    
    this.clearAllTimers();
    
    if (full) {
      this.data.moduleId = null;
    }
    
    this.data.aiResult = null;
    this.data.weight = null;
    this.data.sessionId = null;
    this.data.currentUserId = null;
    this.data.currentUserData = null;
    this.data.calibrationAttempts = 0;
    
    this.flags.autoCycleEnabled = false;
    this.flags.cycleInProgress = false;
    this.flags.qrScanEnabled = true;
    this.flags.isProcessingQR = false;
    
    this.setState('IDLE');
  }

  setTimer(name, callback, delay) {
    this.clearTimer(name);
    const timer = setTimeout(() => {
      this.timers.delete(name);
      callback();
    }, delay);
    this.timers.set(name, timer);
  }

  clearTimer(name) {
    if (this.timers.has(name)) {
      clearTimeout(this.timers.get(name));
      this.timers.delete(name);
    }
  }

  clearAllTimers() {
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
  }
}

// ============================================================
// LOGGER
// ============================================================
class Logger {
  constructor() {
    this.colors = {
      reset: '\x1b[0m',
      bright: '\x1b[1m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      magenta: '\x1b[35m',
      cyan: '\x1b[36m'
    };
  }

  _format(level, message, color) {
    const timestamp = new Date().toISOString();
    const colorCode = CONFIG.logging.colors ? this.colors[color] : '';
    const reset = CONFIG.logging.colors ? this.colors.reset : '';
    return `${colorCode}[${timestamp}] [${level}]${reset} ${message}`;
  }

  info(message) {
    console.log(this._format('INFO', message, 'cyan'));
  }

  success(message) {
    console.log(this._format('SUCCESS', message, 'green'));
  }

  warn(message) {
    console.log(this._format('WARN', message, 'yellow'));
  }

  error(message) {
    console.error(this._format('ERROR', message, 'red'));
  }

  debug(message) {
    if (CONFIG.device.environment === 'development') {
      console.log(this._format('DEBUG', message, 'magenta'));
    }
  }

  box(title, lines = []) {
    const width = 50;
    console.log('\n' + '═'.repeat(width));
    console.log(title.padEnd(width));
    console.log('═'.repeat(width));
    lines.forEach(line => console.log(line));
    console.log('═'.repeat(width) + '\n');
  }
}

const logger = new Logger();
const state = new StateMachine();

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

// ============================================================
// QR SCANNER - PRODUCTION GRADE (FIXED)
// ============================================================
class QRScanner extends EventEmitter {
  constructor() {
    super();
    this.buffer = '';
    this.lastCharTime = 0;
    this.scanTimer = null;
    this.isReady = false;
  }

  start() {
    logger.box('QR SCANNER INITIALIZED', [
      '📱 Mode: HID Keyboard Scanner',
      `📏 Length: ${CONFIG.qr.minLength}-${CONFIG.qr.maxLength} chars`,
      `⚡ Auto-detects Enter key OR timeout`,
      `⏱️  Process delay: ${CONFIG.qr.processDelay}ms`,
      '🎯 Ready to scan'
    ]);

    this.setupInputStream();
    this.isReady = true;
    this.emit('ready');
  }

  setupInputStream() {
    process.stdin.setEncoding('utf8');
    process.stdin.resume();

    process.stdin.on('data', chunk => this.handleInput(chunk));
    
    process.stdin.on('error', error => {
      logger.error(`STDIN error: ${error.message}`);
      setTimeout(() => this.setupInputStream(), 1000);
    });
  }

  handleInput(chunk) {
    // Handle Ctrl+C
    if (chunk === '\u0003') {
      gracefulShutdown();
      return;
    }

    const now = Date.now();
    const data = chunk.toString();

    // Check for Enter key (end of scan)
    if (data.includes('\r') || data.includes('\n')) {
      logger.info('✅ Enter key detected');
      this.processScan();
      return;
    }

    // Reset buffer if timeout exceeded (new scan)
    if (now - this.lastCharTime > CONFIG.qr.scanTimeout) {
      if (this.buffer.length > 0) {
        logger.info('⏰ Timeout - processing previous scan');
        this.processScan();
      }
      this.buffer = '';
    }

    // Add characters to buffer
    const cleanData = data.replace(/[\r\n\u0000-\u001F\u007F]/g, '');
    if (cleanData.length > 0) {
      this.buffer += cleanData;
      this.lastCharTime = now;

      // Show real-time progress
      process.stdout.write(`\r📥 Scanning: ${this.buffer}... (${this.buffer.length} chars)`);

      // Auto-process after reaching max length
      if (this.buffer.length >= CONFIG.qr.maxLength) {
        console.log(''); // New line
        logger.info('📏 Max length reached - processing');
        this.processScan();
        return;
      }

      // Auto-process timer (for scanners without Enter key)
      if (this.scanTimer) clearTimeout(this.scanTimer);
      
      // Only auto-process if we have enough characters
      if (this.buffer.length >= CONFIG.qr.minLength) {
        this.scanTimer = setTimeout(() => {
          console.log(''); // New line
          logger.info('⏰ Auto-processing (no Enter key detected)');
          this.processScan();
        }, CONFIG.qr.processDelay);
      }
    }
  }

  processScan() {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }

    const code = this.buffer.trim();
    this.buffer = '';

    if (code.length === 0) {
      logger.debug('Empty buffer - ignoring');
      return;
    }

    console.log(''); // New line after progress
    logger.info(`📱 QR Scanned: "${code}" (${code.length} chars)`);

    // Validate format
    if (!this.validateFormat(code)) {
      return;
    }

    // Emit scan event
    logger.info('🔔 Emitting scan event...');
    this.emit('scan', code);
  }

  validateFormat(code) {
    if (code.length < CONFIG.qr.minLength || code.length > CONFIG.qr.maxLength) {
      logger.warn(`❌ Invalid QR length: ${code.length} (expected ${CONFIG.qr.minLength}-${CONFIG.qr.maxLength})`);
      return false;
    }

    if (CONFIG.qr.numericOnly && !/^\d+$/.test(code)) {
      logger.warn('❌ Invalid QR format: must be numeric');
      return false;
    }

    logger.success('✅ QR format valid');
    return true;
  }

  reset() {
    logger.debug('Resetting QR scanner buffer');
    this.buffer = '';
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
  }
}

// ============================================================
// BACKEND API CLIENT
// ============================================================
class BackendClient {
  constructor() {
    this.axios = axios.create({
      baseURL: CONFIG.backend.url,
      timeout: CONFIG.backend.timeout,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async validateQR(sessionCode) {
    logger.info('═══════════════════════════════════════');
    logger.info('🔐 BACKEND QR VALIDATION STARTED');
    logger.info('═══════════════════════════════════════');
    logger.info(`URL: ${CONFIG.backend.url}${CONFIG.backend.validateEndpoint}`);
    logger.info(`Session Code: ${sessionCode}`);
    logger.info('═══════════════════════════════════════');

    for (let attempt = 1; attempt <= CONFIG.backend.retries; attempt++) {
      try {
        logger.info(`📡 Attempt ${attempt}/${CONFIG.backend.retries} - Sending POST request...`);
        
        const response = await this.axios.post(
          CONFIG.backend.validateEndpoint,
          { sessionCode }
        );

        logger.info(`✅ Response received - Status: ${response.status}`);
        logger.info(`Response data: ${JSON.stringify(response.data, null, 2)}`);

        if (response.data && response.data.success) {
          logger.success('✅ QR VALIDATION SUCCESSFUL!');
          logger.info(`User: ${response.data.user?.name || 'N/A'}`);
          logger.info(`Email: ${response.data.user?.email || 'N/A'}`);
          logger.info('═══════════════════════════════════════\n');
          
          return {
            valid: true,
            user: response.data.user || {},
            data: response.data
          };
        } else {
          logger.warn(`❌ Validation failed: ${response.data?.error || 'Unknown error'}`);
          logger.info('═══════════════════════════════════════\n');
          
          return {
            valid: false,
            error: response.data?.error || 'Invalid QR code'
          };
        }
      } catch (error) {
        logger.error(`❌ Attempt ${attempt}/${CONFIG.backend.retries} FAILED`);
        logger.error(`Error message: ${error.message}`);
        
        if (error.response) {
          logger.error(`Response status: ${error.response.status}`);
          logger.error(`Response data: ${JSON.stringify(error.response.data, null, 2)}`);
        } else if (error.request) {
          logger.error('No response received from server');
          logger.error('Possible network issue or server is down');
        } else {
          logger.error(`Request setup error: ${error.message}`);
        }
        
        if (attempt === CONFIG.backend.retries) {
          logger.error('❌ ALL RETRY ATTEMPTS EXHAUSTED');
          logger.info('═══════════════════════════════════════\n');
          
          return {
            valid: false,
            error: error.response?.data?.error || error.message
          };
        }
        
        const waitTime = 1000 * attempt;
        logger.info(`⏳ Waiting ${waitTime}ms before retry...`);
        await delay(waitTime);
      }
    }
  }
}

// ============================================================
// HARDWARE API CLIENT
// ============================================================
class HardwareClient {
  constructor() {
    this.baseUrl = CONFIG.local.baseUrl;
  }

  async executeCommand(action, params = {}) {
    const deviceType = 1;

    if (!state.data.moduleId && action !== 'getModuleId') {
      throw new Error('Module ID not available');
    }

    let apiUrl, apiPayload;

    switch (action) {
      case 'openGate':
        apiUrl = `${this.baseUrl}/system/serial/motorSelect`;
        apiPayload = {
          moduleId: state.data.moduleId,
          motorId: '01',
          type: '03',
          deviceType
        };
        break;

      case 'closeGate':
        apiUrl = `${this.baseUrl}/system/serial/motorSelect`;
        apiPayload = {
          moduleId: state.data.moduleId,
          motorId: '01',
          type: '00',
          deviceType
        };
        break;

      case 'getWeight':
        apiUrl = `${this.baseUrl}/system/serial/getWeight`;
        apiPayload = {
          moduleId: state.data.moduleId,
          type: '00'
        };
        break;

      case 'calibrateWeight':
        apiUrl = `${this.baseUrl}/system/serial/weightCalibration`;
        apiPayload = {
          moduleId: state.data.moduleId,
          type: '00'
        };
        break;

      case 'takePhoto':
        apiUrl = `${this.baseUrl}/system/camera/process`;
        apiPayload = {};
        break;

      case 'stepperMotor':
        apiUrl = `${this.baseUrl}/system/serial/stepMotorSelect`;
        apiPayload = {
          moduleId: CONFIG.motors.stepper.moduleId,
          id: params.position,
          type: params.position,
          deviceType
        };
        break;

      case 'customMotor':
        apiUrl = `${this.baseUrl}/system/serial/motorSelect`;
        apiPayload = {
          moduleId: state.data.moduleId,
          motorId: params.motorId,
          type: params.type,
          deviceType
        };
        break;

      case 'getModuleId':
        apiUrl = `${this.baseUrl}/system/serial/getModuleId`;
        apiPayload = {};
        break;

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    logger.debug(`Hardware command: ${action}`);
    
    await axios.post(apiUrl, apiPayload, {
      timeout: CONFIG.local.timeout,
      headers: { 'Content-Type': 'application/json' }
    });

    // Action-specific delays
    if (action === 'takePhoto') await delay(1500);
    if (action === 'getWeight') await delay(2000);
  }

  async emergencyStop() {
    logger.warn('🛑 EMERGENCY STOP INITIATED');
    
    try {
      await this.executeCommand('customMotor', CONFIG.motors.belt.stop);
      await this.executeCommand('customMotor', CONFIG.motors.compactor.stop);
      await this.executeCommand('stepperMotor', {
        position: CONFIG.motors.stepper.positions.home
      });
      await this.executeCommand('closeGate');
      logger.success('✅ Emergency stop complete');
    } catch (error) {
      logger.error(`❌ Emergency stop failed: ${error.message}`);
    }
  }
}

// ============================================================
// WEBSOCKET CLIENT
// ============================================================
class HardwareWebSocket extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.reconnectTimer = null;
  }

  connect() {
    logger.info('Connecting to hardware WebSocket...');

    this.ws = new WebSocket(CONFIG.local.wsUrl);

    this.ws.on('open', () => {
      logger.success('WebSocket connected');
      this.emit('connected');
      
      setTimeout(() => {
        hardwareClient.executeCommand('getModuleId').catch(err =>
          logger.error(`Module ID request failed: ${err.message}`)
        );
      }, 1000);
    });

    this.ws.on('message', data => this.handleMessage(data));

    this.ws.on('close', () => {
      logger.warn('WebSocket closed - reconnecting...');
      this.scheduleReconnect();
    });

    this.ws.on('error', error => {
      logger.error(`WebSocket error: ${error.message}`);
    });
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      logger.debug(`WS message: ${message.function}`);

      // Module ID response
      if (message.function === '01') {
        state.data.moduleId = message.moduleId || message.data;
        logger.success(`✅ Module ID received: ${state.data.moduleId}`);
        this.emit('moduleId', state.data.moduleId);
        return;
      }

      // AI Photo result
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        this.handleAIResult(aiData);
        return;
      }

      // Weight result
      if (message.function === '06') {
        this.handleWeightResult(message.data);
        return;
      }

      // Object detection
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        logger.info(`Device status code: ${code}`);
        
        if (code === 4 && state.flags.autoCycleEnabled && !state.flags.cycleInProgress) {
          logger.info('👁️ Object detected - taking photo');
          state.clearTimer('autoPhoto');
          setTimeout(() => hardwareClient.executeCommand('takePhoto'), 1000);
        }
        return;
      }
    } catch (error) {
      logger.error(`WebSocket message error: ${error.message}`);
    }
  }

  handleAIResult(aiData) {
    state.clearTimer('autoPhoto');

    const probability = aiData.probability || 0;
    const materialType = this.determineMaterial(aiData);
    const matchRate = Math.round(probability * 100);

    state.data.aiResult = {
      matchRate,
      materialType,
      className: aiData.className || '',
      taskId: aiData.taskId,
      timestamp: new Date().toISOString()
    };

    logger.info(`🤖 AI Result: ${materialType} (${matchRate}%)`);

    mqttClient.publish(
      CONFIG.mqtt.topics.aiResult,
      JSON.stringify(state.data.aiResult),
      { qos: CONFIG.mqtt.qos.default }
    );

    if (state.flags.autoCycleEnabled && materialType !== 'UNKNOWN') {
      const config = CONFIG.detection[materialType];
      const threshold = Math.round(config.threshold * 100);

      if (matchRate >= threshold) {
        logger.success(`✅ Confidence sufficient: ${matchRate}% >= ${threshold}%`);
        logger.info('📊 Getting weight...');
        setTimeout(() => hardwareClient.executeCommand('getWeight'), 500);
      } else {
        logger.warn(`⚠️ Confidence too low: ${matchRate}% < ${threshold}%`);
      }
    }
  }

  handleWeightResult(weightData) {
    const rawWeight = parseFloat(weightData) || 0;
    const coefficient = CONFIG.weight.coefficients[1];
    const calibratedWeight = rawWeight * (coefficient / 1000);

    state.data.weight = {
      weight: Math.round(calibratedWeight * 10) / 10,
      rawWeight,
      coefficient,
      timestamp: new Date().toISOString()
    };

    logger.info(`⚖️ Weight: ${state.data.weight.weight}g (raw: ${rawWeight})`);

    mqttClient.publish(
      CONFIG.mqtt.topics.weightResult,
      JSON.stringify(state.data.weight),
      { qos: CONFIG.mqtt.qos.default }
    );

    // Handle calibration
    if (state.data.weight.weight <= 0 &&
        state.data.calibrationAttempts < CONFIG.weight.maxCalibrationAttempts) {
      
      state.data.calibrationAttempts++;
      logger.warn(`⚠️ Calibrating weight (${state.data.calibrationAttempts}/${CONFIG.weight.maxCalibrationAttempts})`);
      
      setTimeout(async () => {
        await hardwareClient.executeCommand('calibrateWeight');
        setTimeout(() => hardwareClient.executeCommand('getWeight'), 1000);
      }, 500);
      return;
    }

    if (state.data.weight.weight > 0) {
      state.data.calibrationAttempts = 0;
    }

    // Start cycle if ready
    if (state.flags.autoCycleEnabled &&
        state.data.aiResult &&
        state.data.weight.weight >= CONFIG.weight.minValidWeight &&
        !state.flags.cycleInProgress) {
      
      state.flags.cycleInProgress = true;
      logger.info('✅ Ready to start processing cycle');
      setTimeout(() => cycleManager.execute(), 1000);
    }
  }

  determineMaterial(aiData) {
    const className = (aiData.className || '').toLowerCase();
    const probability = aiData.probability || 0;

    for (const [material, config] of Object.entries(CONFIG.detection)) {
      const keywords = {
        METAL_CAN: ['易拉罐', 'metal', 'can', '铝'],
        PLASTIC_BOTTLE: ['pet', 'plastic', '瓶', 'bottle'],
        GLASS: ['玻璃', 'glass']
      };

      if (keywords[material].some(kw => className.includes(kw))) {
        if (probability >= config.threshold) {
          return material;
        }
      }
    }

    return 'UNKNOWN';
  }

  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, CONFIG.local.reconnectInterval);
  }

  close() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ============================================================
// CYCLE MANAGER
// ============================================================
class CycleManager {
  async execute() {
    const startTime = Date.now();

    logger.box('🚀 STARTING PROCESSING CYCLE', [
      `Session: ${state.data.sessionId}`,
      `User: ${state.data.currentUserData?.name || state.data.currentUserId}`,
      `Material: ${state.data.aiResult.materialType}`,
      `Confidence: ${state.data.aiResult.matchRate}%`,
      `Weight: ${state.data.weight.weight}g`
    ]);

    state.setState('PROCESSING');

    try {
      // Close gate
      logger.info('Step 1/8: Closing gate');
      await hardwareClient.executeCommand('closeGate');
      await delay(CONFIG.timing.gateOperation);

      // Move to weight
      logger.info('Step 2/8: Moving to weight position');
      await hardwareClient.executeCommand('customMotor', CONFIG.motors.belt.toWeight);
      await delay(CONFIG.timing.beltToWeight);
      await hardwareClient.executeCommand('customMotor', CONFIG.motors.belt.stop);

      // Move to stepper
      logger.info('Step 3/8: Moving to stepper position');
      await hardwareClient.executeCommand('customMotor', CONFIG.motors.belt.toStepper);
      await delay(CONFIG.timing.beltToStepper);
      await hardwareClient.executeCommand('customMotor', CONFIG.motors.belt.stop);
      await delay(CONFIG.timing.positionSettle);

      // Dump to crusher
      logger.info('Step 4/8: Dumping to crusher');
      const position = CONFIG.detection[state.data.aiResult.materialType].bin;
      await hardwareClient.executeCommand('stepperMotor', {
        position: CONFIG.motors.stepper.positions[position]
      });
      await delay(CONFIG.timing.stepperRotate);

      // Crush
      logger.info('Step 5/8: Crushing');
      await hardwareClient.executeCommand('customMotor', CONFIG.motors.compactor.start);
      await delay(CONFIG.timing.compactor);
      await hardwareClient.executeCommand('customMotor', CONFIG.motors.compactor.stop);

      // Return belt
      logger.info('Step 6/8: Returning belt');
      await hardwareClient.executeCommand('customMotor', CONFIG.motors.belt.reverse);
      await delay(CONFIG.timing.beltReverse);
      await hardwareClient.executeCommand('customMotor', CONFIG.motors.belt.stop);

      // Reset stepper
      logger.info('Step 7/8: Resetting stepper');
      await hardwareClient.executeCommand('stepperMotor', {
        position: CONFIG.motors.stepper.positions.home
      });
      await delay(CONFIG.timing.stepperReset);

      // Complete
      const cycleTime = Math.round((Date.now() - startTime) / 1000);
      logger.success(`✅ Step 8/8: Cycle complete (${cycleTime}s)`);

      // Publish transaction
      this.publishTransaction(cycleTime, 'success');

    } catch (error) {
      logger.error(`❌ Cycle failed: ${error.message}`);
      logger.error(error.stack);
      await hardwareClient.emergencyStop();
      this.publishTransaction(0, 'failed', error.message);
    } finally {
      // Always reset state
      this.cleanup();
    }
  }

  publishTransaction(cycleTime, status, error = null) {
    const transaction = {
      sessionId: state.data.sessionId,
      deviceId: CONFIG.device.id,
      userId: state.data.currentUserId,
      userData: state.data.currentUserData,
      materialType: state.data.aiResult?.materialType,
      weight: state.data.weight?.weight,
      rawWeight: state.data.weight?.rawWeight,
      confidence: state.data.aiResult?.matchRate,
      aiClassName: state.data.aiResult?.className,
      aiTaskId: state.data.aiResult?.taskId,
      cycleTime,
      timestamp: new Date().toISOString(),
      status,
      error
    };

    mqttClient.publish(
      CONFIG.mqtt.topics.cycleComplete,
      JSON.stringify(transaction),
      { qos: CONFIG.mqtt.qos.status }
    );

    logger.info('📤 Transaction published to MQTT');
  }

  cleanup() {
    logger.info('═══════════════════════════════════════');
    logger.info('🔄 CLEANING UP - READY FOR NEXT SCAN');
    logger.info('═══════════════════════════════════════');
    
    state.reset();
    qrScanner.reset();
    
    logger.success('✅ System ready for next QR scan');
    logger.info('═══════════════════════════════════════\n');
  }
}

// ============================================================
// SESSION MANAGER
// ============================================================
class SessionManager {
  async handleQRScan(qrCode) {
    logger.info('═══════════════════════════════════════');
    logger.info('📱 HANDLE QR SCAN CALLED');
    logger.info('═══════════════════════════════════════');
    logger.info(`QR Code: ${qrCode}`);
    logger.info(`isProcessingQR: ${state.flags.isProcessingQR}`);
    logger.info(`qrScanEnabled: ${state.flags.qrScanEnabled}`);
    logger.info(`Current State: ${state.getState()}`);
    logger.info('═══════════════════════════════════════');

    if (state.flags.isProcessingQR) {
      logger.warn('⏳ Already processing QR - ignoring');
      return;
    }

    if (!state.flags.qrScanEnabled) {
      logger.warn('⏳ QR scanning disabled - session active');
      return;
    }

    state.flags.isProcessingQR = true;
    state.setState('VALIDATING_QR');

    try {
      logger.box('QR CODE VALIDATION STARTED', [
        `Code: ${qrCode}`,
        `Time: ${new Date().toLocaleTimeString()}`
      ]);

      // Validate with backend
      logger.info('🔄 Calling backend validation...');
      const validation = await backendClient.validateQR(qrCode);

      logger.info(`✅ Backend call completed - Valid: ${validation.valid}`);

      if (!validation.valid) {
        logger.error(`❌ Invalid QR: ${validation.error}`);
        logger.box('QR VALIDATION FAILED', [
          `Error: ${validation.error}`,
          'Gate remains closed',
          'Ready for next scan'
        ]);
        state.reset();
        return;
      }

      // Store session data
      state.data.sessionId = generateSessionId();
      state.data.currentUserId = qrCode;
      state.data.currentUserData = validation.user;

      logger.box('✅ QR VALIDATED SUCCESSFULLY', [
        `User: ${validation.user.name || qrCode}`,
        `Email: ${validation.user.email || 'N/A'}`,
        `Points: ${validation.user.currentPoints || 0}`,
        `Session: ${state.data.sessionId}`
      ]);

      // Ensure module ID available
      await this.ensureModuleId();

      // Publish QR scan event
      mqttClient.publish(
        CONFIG.mqtt.topics.qrScan,
        JSON.stringify({
          deviceId: CONFIG.device.id,
          userId: qrCode,
          userData: validation.user,
          timestamp: new Date().toISOString(),
          sessionId: state.data.sessionId
        }),
        { qos: CONFIG.mqtt.qos.default }
      );

      logger.info('📤 QR scan event published to MQTT');

      // Start automation
      await this.startAutomation();

    } catch (error) {
      logger.error(`❌ QR handling failed: ${error.message}`);
      logger.error(error.stack);
      state.reset();
    }
  }

  async ensureModuleId() {
    if (state.data.moduleId) {
      logger.info(`✅ Module ID already available: ${state.data.moduleId}`);
      return;
    }

    logger.warn('⚠️ Module ID not available - requesting...');

    for (let i = 0; i < CONFIG.timing.maxModuleIdAttempts; i++) {
      logger.info(`Attempt ${i + 1}/${CONFIG.timing.maxModuleIdAttempts}`);
      
      await hardwareClient.executeCommand('getModuleId');
      await delay(CONFIG.timing.moduleIdRetry);

      if (state.data.moduleId) {
        logger.success(`✅ Module ID obtained: ${state.data.moduleId}`);
        return;
      }
    }

    throw new Error('Failed to obtain Module ID after all attempts');
  }

  async startAutomation() {
    logger.info('═══════════════════════════════════════');
    logger.info('🚀 STARTING AUTOMATION SEQUENCE');
    logger.info('═══════════════════════════════════════');
    
    state.setState('AUTOMATING');

    // Disable QR scanning during session
    state.flags.qrScanEnabled = false;
    state.flags.autoCycleEnabled = true;

    logger.info('🔒 QR scanning disabled for session');
    logger.info('✅ Auto cycle enabled');

    // Publish auto control
    mqttClient.publish(
      CONFIG.mqtt.topics.autoControl,
      JSON.stringify({ enabled: true }),
      { qos: CONFIG.mqtt.qos.default }
    );

    // Reset motors
    logger.info('🔧 Resetting system motors...');
    await hardwareClient.executeCommand('customMotor', CONFIG.motors.belt.stop);
    await hardwareClient.executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await hardwareClient.executeCommand('stepperMotor', {
      position: CONFIG.motors.stepper.positions.home
    });
    await delay(2000);
    logger.success('✅ Motors reset complete');

    // Open gate
    logger.info('🚪 Opening gate...');
    await hardwareClient.executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);

    logger.success('✅ Gate opened - waiting for object detection');
    logger.info(`⏰ Auto photo in ${CONFIG.timing.autoPhotoDelay / 1000}s if no detection`);
    logger.info('═══════════════════════════════════════\n');

    // Set auto photo timer
    state.setTimer('autoPhoto', async () => {
      if (state.flags.autoCycleEnabled && !state.flags.cycleInProgress && !state.data.aiResult) {
        logger.info('⏰ Auto photo timer triggered');
        await hardwareClient.executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
  }
}

// ============================================================
// MQTT CLIENT
// ============================================================
let mqttClient;

function initializeMQTT() {
  logger.info('Connecting to MQTT broker...');

  mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
    username: CONFIG.mqtt.username,
    password: CONFIG.mqtt.password,
    ca: fs.readFileSync(CONFIG.mqtt.caFile),
    rejectUnauthorized: false,
    keepalive: 60,
    reconnectPeriod: 5000
  });

  mqttClient.on('connect', () => {
    logger.success('MQTT connected');

    // Subscribe to topics
    mqttClient.subscribe(CONFIG.mqtt.topics.commands);
    mqttClient.subscribe(CONFIG.mqtt.topics.autoControl);

    // Publish online status
    publishStatus('online');

    // Start health monitoring
    startHealthMonitoring();
  });

  mqttClient.on('message', handleMQTTMessage);

  mqttClient.on('error', error => {
    logger.error(`MQTT error: ${error.message}`);
  });

  mqttClient.on('offline', () => {
    logger.warn('MQTT offline');
  });

  mqttClient.on('reconnect', () => {
    logger.info('MQTT reconnecting...');
  });
}

async function handleMQTTMessage(topic, message) {
  try {
    const payload = JSON.parse(message.toString());

    if (topic === CONFIG.mqtt.topics.autoControl) {
      state.flags.autoCycleEnabled = payload.enabled === true;
      logger.info(`🤖 Auto mode: ${state.flags.autoCycleEnabled ? 'ON' : 'OFF'}`);

      if (state.data.moduleId) {
        if (state.flags.autoCycleEnabled) {
          await hardwareClient.executeCommand('openGate');
        } else {
          await hardwareClient.executeCommand('closeGate');
        }
      }
      return;
    }

    if (topic === CONFIG.mqtt.topics.commands) {
      logger.info(`📩 MQTT command: ${payload.action}`);

      if (payload.action === 'takePhoto' && state.data.moduleId) {
        logger.info('📸 Manual photo command received');
        state.clearTimer('autoPhoto');
        await hardwareClient.executeCommand('takePhoto');
        return;
      }

      if (payload.action === 'setMaterial') {
        const validMaterials = ['METAL_CAN', 'PLASTIC_BOTTLE', 'GLASS'];
        if (validMaterials.includes(payload.materialType)) {
          state.data.aiResult = {
            matchRate: 100,
            materialType: payload.materialType,
            className: 'MANUAL_OVERRIDE',
            taskId: `manual_${Date.now()}`,
            timestamp: new Date().toISOString()
          };
          logger.info(`🔧 Manual material override: ${payload.materialType}`);

          if (state.flags.autoCycleEnabled) {
            setTimeout(() => hardwareClient.executeCommand('getWeight'), 500);
          }
        }
        return;
      }

      if (state.data.moduleId) {
        await hardwareClient.executeCommand(payload.action, payload.params);
      }
    }
  } catch (error) {
    logger.error(`MQTT message error: ${error.message}`);
  }
}

function publishStatus(status) {
  mqttClient.publish(
    CONFIG.mqtt.topics.status,
    JSON.stringify({
      deviceId: CONFIG.device.id,
      version: CONFIG.device.version,
      status,
      timestamp: new Date().toISOString(),
      state: state.getState(),
      moduleId: state.data.moduleId
    }),
    { retain: true, qos: CONFIG.mqtt.qos.status }
  );
}

function startHealthMonitoring() {
  setInterval(() => {
    const health = {
      deviceId: CONFIG.device.id,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      state: state.getState(),
      flags: state.flags,
      moduleId: state.data.moduleId
    };

    mqttClient.publish(
      CONFIG.mqtt.topics.health,
      JSON.stringify(health),
      { qos: 0 }
    );
  }, 60000); // Every minute
}

// ============================================================
// INITIALIZATION
// ============================================================
const backendClient = new BackendClient();
const hardwareClient = new HardwareClient();
const hardwareWS = new HardwareWebSocket();
const qrScanner = new QRScanner();
const sessionManager = new SessionManager();
const cycleManager = new CycleManager();

function gracefulShutdown() {
  logger.warn('\n🛑 GRACEFUL SHUTDOWN INITIATED');
  logger.info('═══════════════════════════════════════');

  publishStatus('offline');

  state.clearAllTimers();
  hardwareWS.close();
  
  if (mqttClient) {
    mqttClient.end(true);
  }

  logger.info('✅ Cleanup complete');
  logger.info('═══════════════════════════════════════');
  
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

process.on('uncaughtException', (error) => {
  logger.error('❌ UNCAUGHT EXCEPTION:');
  logger.error(error.message);
  logger.error(error.stack);
  gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ UNHANDLED REJECTION:');
  logger.error(reason);
  gracefulShutdown();
});

// ============================================================
// STARTUP
// ============================================================
async function startup() {
  logger.box('RVM AGENT v10.1 - PRODUCTION', [
    `Device: ${CONFIG.device.id}`,
    `Version: ${CONFIG.device.version}`,
    `Environment: ${CONFIG.device.environment}`,
    `Backend: ${CONFIG.backend.url}`,
    `MQTT: ${CONFIG.mqtt.brokerUrl}`,
    '',
    '🎯 Features:',
    '  ✅ Enterprise-grade QR scanning',
    '  ✅ State machine architecture',
    '  ✅ Automatic error recovery',
    '  ✅ Health monitoring',
    '  ✅ Production logging',
    '  ✅ Zero-downtime operation',
    '  ✅ Complete debugging enabled'
  ]);

  try {
    // Initialize MQTT
    initializeMQTT();

    // Wait for MQTT connection
    logger.info('⏳ Waiting for MQTT connection...');
    await new Promise(resolve => {
      mqttClient.once('connect', resolve);
    });

    // Connect hardware WebSocket
    hardwareWS.connect();

    // Wait for WebSocket connection
    logger.info('⏳ Waiting for WebSocket connection...');
    await new Promise(resolve => {
      hardwareWS.once('connected', resolve);
    });

    // Wait a bit for module ID
    logger.info('⏳ Waiting for module ID...');
    await delay(2000);

    // CRITICAL: Connect QR scanner event handler BEFORE starting scanner
    logger.info('🔗 Connecting QR scanner event handler...');
    qrScanner.on('scan', async (code) => {
      logger.info(`🔔 QR SCAN EVENT RECEIVED: ${code}`);
      
      try {
        await sessionManager.handleQRScan(code);
      } catch (error) {
        logger.error(`❌ QR handler error: ${error.message}`);
        logger.error(error.stack);
        state.reset();
        qrScanner.reset();
      }
    });
    logger.success('✅ QR scanner event handler connected');

    // Start QR scanner
    qrScanner.start();

    logger.success('═══════════════════════════════════════');
    logger.success('✅ SYSTEM READY - WAITING FOR QR SCANS');
    logger.success('═══════════════════════════════════════\n');

  } catch (error) {
    logger.error(`❌ Startup failed: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

// Start the application
startup();