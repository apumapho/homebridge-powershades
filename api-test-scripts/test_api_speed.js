const { PowerShadesApi } = require('../api');

(async () => {
  const email = process.env.POWERSHADES_EMAIL;
  const password = process.env.POWERSHADES_PASSWORD;

  if (!email || !password) {
    console.error('Please set POWERSHADES_EMAIL and POWERSHADES_PASSWORD environment variables');
    process.exit(1);
  }

  const api = new PowerShadesApi({
    email,
    password
  });

  console.log('Testing API response times...\n');

  // Test login
  let start = Date.now();
  await api.login();
  console.log(`Login: ${Date.now() - start}ms`);

  // Test getShades
  start = Date.now();
  const shades = await api.getShades();
  console.log(`getShades (${shades.length} shades): ${Date.now() - start}ms`);

  // Test single shade move
  console.log('\nTesting single shade move...');
  start = Date.now();
  await api.moveShade('Family Room Door', 50);
  console.log(`moveShade (single): ${Date.now() - start}ms`);

  // Wait a bit
  await new Promise(r => setTimeout(r, 2000));

  // Test parallel moves (5 shades)
  console.log('\nTesting parallel moves...');
  start = Date.now();
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(api.moveShade(shades[i].name, 75));
  }
  await Promise.all(promises);
  console.log(`moveShade (5 parallel): ${Date.now() - start}ms`);

  console.log('\n=== Summary ===');
  console.log('Typical operation (getShades + moveShade):');
  start = Date.now();
  await api.getShades();
  await api.moveShade('Family Room Door', 100);
  console.log(`  Total: ${Date.now() - start}ms`);
})();
