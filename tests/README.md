# Test Scripts

These scripts are for testing the PowerShades API integration during development.

## Setup

Set your PowerShades credentials as environment variables:

```bash
export POWERSHADES_EMAIL="your-email@example.com"
export POWERSHADES_PASSWORD="your-password"
```

Or create a `.env` file in the root directory (automatically loaded by `test_powershades_api.js`):

```
POWERSHADES_USERNAME=your-email@example.com
POWERSHADES_PASSWORD=your-password
```

## Running Tests

```bash
# Basic API test
node tests/test_powershades_api.js

# Test specific endpoints
node tests/test_api_endpoints.js

# Test API response times
node tests/test_api_speed.js
```

## Note

**Never commit credentials to the repository.** These test scripts use environment variables to keep credentials secure.
