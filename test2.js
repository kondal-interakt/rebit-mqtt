// basket-motor-finder.js
const axios = require('axios');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function askQuestion(question) {
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer.trim());
    });
  });
}

async function testMotor(motorId) {
  console.log(`\n🔧 Testing Motor ${motorId}...`);
  
  try {
    // Test forward
    await axios.post('http://localhost:8081/system/serial/motorSelect', {
      moduleId: '09',
      motorId: motorId,
      type: '03',
      deviceType: 1
    });
    
    console.log(`   ✅ Motor ${motorId} started (FORWARD)`);
    console.log(`   ⚠️  WATCH THE BASKET CAREFULLY!`);
    
    await delay(3000);
    
    // Stop
    await axios.post('http://localhost:8081/system/serial/motorSelect', {
      moduleId: '09',
      motorId: motorId,
      type: '00',
      deviceType: 1
    });
    
    console.log(`   ✅ Motor ${motorId} stopped`);
    
    const result = await askQuestion(`   Did Motor ${motorId} move the BASKET? (y/n): `);
    return result.toLowerCase() === 'y';
    
  } catch (err) {
    console.log(`   ❌ Motor ${motorId} error or not exists`);
    return false;
  }
}

async function main() {
  console.log('🔍 FINDING BASKET SORTER MOTOR\n');
  
  // Test motors 07-0F (hexadecimal)
  const motorsToTest = ['07', '08', '09', '0A', '0B', '0C', '0D', '0E', '0F'];
  
  for (const motorId of motorsToTest) {
    const isBasketMotor = await testMotor(motorId);
    if (isBasketMotor) {
      console.log(`\n🎉 FOUND IT! Motor ${motorId} controls the BASKET!`);
      console.log(`📝 Update your code: sorter.motorId = "${motorId}"`);
      break;
    }
    await delay(1000);
  }
  
  rl.close();
}

main().catch(console.error);