const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

const CONFIG = {
  device: {
    id: 'RVM-3101'
  },
  
  backend: {
    url: 'https://rebit-api.ceewen.xyz',
    validateEndpoint: '/api/rvm/RVM-3101/qr/validate',
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
      qrScan: 'rvm/RVM-3101/qr/scanned'
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
    GLASS: 0.25
  },
  
  timing: {
    beltToWeight: 3000,
    beltToStepper: 4000,
    beltReverse: 5000,
    stepperRotate: 4000,
    stepperReset: 6000,
    compactor: 10000,
    positionSettle: 500,
    gateOperation: 1000,
    autoPhotoDelay: 5000
  },
  
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  }
};

const state = {
  moduleId: null,
  aiResult: null,
  weight: null,
  autoCycleEnabled: false,
  cycleInProgress: false,
  calibrationAttempts: 0,
  ws: null,
  sessionId: null,
  currentUserId: null,
  currentUserData: null,
  autoPhotoTimer: null
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}`;

function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;

  if (className.includes('can') || className.includes('metal')) {
    return probability >= CONFIG.detection.METAL_CAN ? 'METAL_CAN' : 'UNKNOWN';
  }
  if (className.includes('bottle') || className.includes('plastic') || className.includes('pet')) {
    return probability >= CONFIG.detection.PLASTIC_BOTTLE ? 'PLASTIC_BOTTLE' : 'UNKNOWN';
  }
  if (className.includes('glass')) {
    return probability >= CONFIG.detection.GLASS ? 'GLASS' : 'UNKNOWN';
  }
  
  return 'UNKNOWN';
}

async function executeCommand(action, params = {}) {
  if (!state.moduleId) {
    console.log('⚠️ No module ID');
    return;
  }

  const moduleId = '05';
  let endpoint = '';
  let body = {};

  switch (action) {
    case 'openGate':
      endpoint = '/system/serial/motorSelect';
      body = { moduleId, motorId: '01', type: '03', deviceType: 1 };
      await delay(CONFIG.timing.gateOperation);
      break;

    case 'closeGate':
      endpoint = '/system/serial/motorSelect';
      body = { moduleId, motorId: '01', type: '00', deviceType: 1 };
      await delay(CONFIG.timing.gateOperation);
      break;

    case 'takePhoto':
      endpoint = '/system/camera/process';
      break;

    case 'getWeight':
      endpoint = '/system/serial/getWeight';
      body = { moduleId: '06', type: '00' };
      break;

    case 'calibrateWeight':
      endpoint = '/system/serial/weightCalibration';
      body = { moduleId: '07', type: '00' };
      break;

    case 'stepperMotor':
      endpoint = '/system/serial/stepMotorSelect';
      body = { moduleId: '0F', type: params.position || '01', deviceType: 1 };
      break;

    case 'customMotor':
      endpoint = '/system/serial/motorSelect';
      body = { moduleId, ...params, deviceType: 1 };
      break;

    default:
      console.log(`❌ Unknown: ${action}`);
      return;
  }

  try {
    await axios.post(`${CONFIG.local.baseUrl}${endpoint}`, body, {
      timeout: CONFIG.local.timeout,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error(`❌ ${action} failed:`, error.message);
  }
}

async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    console.log('⚠️ Missing data');
    state.cycleInProgress = false;
    return;
  }

  state.sessionId = generateSessionId();
  
  console.log('\n========== AUTO CYCLE START ==========');
  console.log(`🔹 Material: ${state.aiResult.materialType}`);
  console.log(`🔹 Weight: ${state.weight.weight}g`);
  console.log(`🔹 Session: ${state.sessionId}`);
  console.log('======================================\n');

  try {
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(CONFIG.timing.positionSettle);

    if (state.aiResult.materialType === 'METAL_CAN') {
      await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.metalCan });
      await delay(CONFIG.timing.stepperRotate);
    } else if (state.aiResult.materialType === 'PLASTIC_BOTTLE') {
      await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.plasticBottle });
      await delay(CONFIG.timing.stepperRotate);
    }

    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);

    const cycleData = {
      sessionId: state.sessionId,
      deviceId: CONFIG.device.id,
      materialType: state.aiResult.materialType,
      weight: state.weight.weight,
      aiMatchRate: state.aiResult.matchRate,
      userId: state.currentUserId,
      timestamp: new Date().toISOString()
    };

    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));
    
    console.log('✅ CYCLE COMPLETE\n');

  } catch (error) {
    console.error('❌ Cycle error:', error.message);
  } finally {
    state.cycleInProgress = false;
    state.aiResult = null;
    state.weight = null;
    state.calibrationAttempts = 0;
  }
}

async function emergencyStop() {
  console.log('🛑 EMERGENCY STOP');
  
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await executeCommand('closeGate');
  } catch (error) {
    console.error('❌ Emergency stop failed:', error.message);
  }
}

function connectWebSocket() {
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    console.log('✅ WebSocket connected');
    setTimeout(() => requestModuleId(), 1000);
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      console.log(`📡 WS: ${message.function || message.type}`);
      
      if (message.type === 'qr_validated') {
        console.log('\n========================================');
        console.log('✅ QR VALIDATED BY FRONTEND');
        console.log('========================================');
        console.log(`👤 User: ${message.userName || 'Unknown'}`);
        console.log(`🔑 Session: ${message.sessionCode}`);
        console.log('========================================\n');
        
        state.currentUserId = message.userId;
        state.currentUserData = {
          name: message.userName,
          email: message.userEmail,
          sessionCode: message.sessionCode,
          timestamp: message.timestamp
        };
        
        if (state.ws && state.ws.readyState === 1) {
          state.ws.send(JSON.stringify({
            type: 'ack',
            message: 'QR received'
          }));
        }
        
        if (message.startAutoCycle) {
          state.autoCycleEnabled = true;
          console.log('🤖 AUTO CYCLE ENABLED');
          
          mqttClient.publish(CONFIG.mqtt.topics.qrScan, JSON.stringify({
            sessionCode: message.sessionCode,
            userId: message.userId,
            userName: message.userName,
            timestamp: message.timestamp,
            deviceId: CONFIG.device.id
          }));
          
          console.log('🚪 Opening gate...\n');
          await executeCommand('openGate');
          
          console.log('⏱️  Auto photo in 5 seconds...\n');
          
          if (state.autoPhotoTimer) {
            clearTimeout(state.autoPhotoTimer);
          }
          
          state.autoPhotoTimer = setTimeout(() => {
            console.log('📸 AUTO PHOTO!\n');
            executeCommand('takePhoto');
          }, CONFIG.timing.autoPhotoDelay);
        }
        
        return;
      }
      
      if (message.function === '01') {
        state.moduleId = message.moduleId || message.data;
        console.log(`✅ Module ID: ${state.moduleId}`);
        return;
      }
      
      if (message.function === 'aiPhoto') {
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        
        const aiData = JSON.parse(message.data);
        const probability = aiData.probability || 0;
        
        state.aiResult = {
          matchRate: Math.round(probability * 100),
          materialType: determineMaterialType(aiData),
          className: aiData.className || '',
          taskId: aiData.taskId,
          timestamp: new Date().toISOString()
        };
        
        console.log(`🤖 AI: ${state.aiResult.materialType} (${state.aiResult.matchRate}%)`);
        
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        
        if (state.autoCycleEnabled && state.aiResult.materialType !== 'UNKNOWN') {
          const threshold = CONFIG.detection[state.aiResult.materialType];
          const thresholdPercent = Math.round(threshold * 100);
          
          if (state.aiResult.matchRate >= thresholdPercent) {
            console.log('✅ Proceeding to weight...\n');
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            console.log(`⚠️ Low confidence (${state.aiResult.matchRate}% < ${thresholdPercent}%)\n`);
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
      
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        
        if (code === 4 && state.autoCycleEnabled && !state.cycleInProgress) {
          console.log('👤 OBJECT DETECTED!\n');
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
      
      if (payload.action === 'takePhoto' && state.moduleId) {
        console.log('📸 MANUAL PHOTO!\n');
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
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

async function requestModuleId() {
  try {
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('❌ Module ID failed:', error.message);
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

console.log('========================================');
console.log('🚀 RVM AGENT - FRONTEND QR INTEGRATED');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log(`🔐 Backend: ${CONFIG.backend.url}`);
console.log('✅ QR scanning via frontend');
console.log('========================================');
console.log('⏳ Starting...\n');