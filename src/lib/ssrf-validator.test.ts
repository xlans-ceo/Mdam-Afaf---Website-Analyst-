import test from 'node:test';
import assert from 'node:assert/strict';
import { isRestrictedIp, validateSsrfUrl } from './ssrf-validator';

test('isRestrictedIp detects loopback, private networks and cloud metadata', () => {
  // Loopback
  assert.equal(isRestrictedIp('127.0.0.1'), true);
  assert.equal(isRestrictedIp('127.0.0.2'), true);
  assert.equal(isRestrictedIp('::1'), true);

  // Private IPv4 (RFC 1918)
  assert.equal(isRestrictedIp('10.0.0.1'), true);
  assert.equal(isRestrictedIp('172.16.0.5'), true);
  assert.equal(isRestrictedIp('172.31.255.255'), true);
  assert.equal(isRestrictedIp('192.168.1.1'), true);

  // Cloud metadata & Link local (169.254.169.254)
  assert.equal(isRestrictedIp('169.254.169.254'), true);
  assert.equal(isRestrictedIp('169.254.1.1'), true);

  // Public safe IPv4
  assert.equal(isRestrictedIp('8.8.8.8'), false);
  assert.equal(isRestrictedIp('1.1.1.1'), false);
  assert.equal(isRestrictedIp('93.184.216.34'), false);
});

test('validateSsrfUrl rejects credentials and disallowed schemes', async () => {
  // Disallowed scheme
  const ftp = await validateSsrfUrl('ftp://example.com/file');
  assert.equal(ftp.valid, false);

  const fileProto = await validateSsrfUrl('file:///etc/passwd');
  assert.equal(fileProto.valid, false);

  // Embedded credentials
  const withCreds = await validateSsrfUrl('https://admin:secret123@example.com');
  assert.equal(withCreds.valid, false);

  // Localhost names
  const localhost = await validateSsrfUrl('http://localhost:8080');
  assert.equal(localhost.valid, false);

  const metadata = await validateSsrfUrl('http://metadata.google.internal/computeMetadata/v1/');
  assert.equal(metadata.valid, false);
});
