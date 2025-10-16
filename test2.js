// test-stepper.js
const axios = require('axios');

async function testStepper() {
  console.log('🔧 Testing Stepper Motor for Basket Control');
  
  // Move to different positions
  const positions = [
    { code: '01', desc: 'Position 1' },
    { code: '02', desc: 'Position 2' }, 
    { code: '03', desc: 'Position 3' },
    { code: '04', desc: 'Position 4' }
  ];
  
  for (const pos of positions) {
    console.log(`\n🔄 Moving stepper to ${pos.desc} (${pos.code})`);
    console.log('⚠️  WATCH THE BASKET!');
    
    await axios.post('http://localhost:8081/system/serial/stepMotorSelect', {
      moduleId: '0F',
      type: pos.code,
      deviceType: 1
    });
    
    await delay(5000);
    
    // Return to home
    await axios.post('http://localhost:8081/system/serial/stepMotorSelect', {
      moduleId: '0F',
      type: '01',
      deviceType: 1
    });
    
    await delay(2000);
  }
}

testStepper();