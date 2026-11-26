import { networkInterfaces } from 'node:os';

function ipv4Number(address) {
  const octets = address.split('.');
  if (octets.length !== 4 || octets.some(octet => !/^(?:0|[1-9]\d{0,2})$/.test(octet) || Number(octet) > 255)) {
    return null;
  }
  return octets.reduce((value, octet) => value * 256 + Number(octet), 0);
}

const privateRanges = [
  { address: '10.0.0.0', netmask: '255.0.0.0' },
  { address: '172.16.0.0', netmask: '255.240.0.0' },
  { address: '192.168.0.0', netmask: '255.255.0.0' }
].map(({ address, netmask }) => ({
  address: ipv4Number(address),
  netmask: ipv4Number(netmask)
}));

function isPrivateIPv4(address) {
  return privateRanges.some(range => (address & range.netmask) === (range.address & range.netmask));
}

export function getPrivateIPv4Networks(interfaces = networkInterfaces()) {
  return Object.values(interfaces).flat()
    .filter(interfaceInfo => interfaceInfo
      && !interfaceInfo.internal
      && (interfaceInfo.family === 'IPv4' || interfaceInfo.family === 4)
      && ipv4Number(interfaceInfo.address) !== null
      && ipv4Number(interfaceInfo.netmask) !== null
      && ipv4Number(interfaceInfo.netmask) !== 0
      && isPrivateIPv4(ipv4Number(interfaceInfo.address)))
    .map(({ address, netmask }) => ({ address, netmask }));
}

export function isLocalNetworkAddress(remoteAddress, networks) {
  const address = remoteAddress?.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;
  if (address === '::1' || address === '127.0.0.1') return true;

  const client = ipv4Number(address || '');
  if (client === null) return false;

  return networks.some(network => {
    const local = ipv4Number(network.address);
    const netmask = ipv4Number(network.netmask);
    return local !== null && netmask !== null && netmask !== 0
      && (client & netmask) === (local & netmask);
  });
}
