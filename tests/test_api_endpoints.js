#!/usr/bin/env node
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
  await api.login();

  const endpoints = [
    '/gateways/',
    '/hubs/',
    '/properties/',
    '/properties/3918/',
    '/properties/3918/gateways/',
    '/properties/3918/devices/'
  ];

  for (const ep of endpoints) {
    try {
      const data = await api.request('get', ep);
      console.log(`\n=== ${ep} ===`);
      console.log(JSON.stringify(data, null, 2).substring(0, 2000));
    } catch (e) {
      console.log(`\n=== ${ep} === ERROR: ${e.message}`);
    }
  }
})();
