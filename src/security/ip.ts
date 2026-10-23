/**
 * Classifies IP addresses as public or not (loopback, private, link-local,
 * cloud metadata, unspecified, multicast, reserved, documentation). IPv6
 * addresses that embed an IPv4 address (IPv4-mapped, IPv4-compatible, NAT64,
 * 6to4) are judged by the embedded IPv4 address as well.
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';

const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (includes Alibaba metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (includes 169.254.169.254 metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments (includes Oracle metadata 192.0.0.192)
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes broadcast
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local (includes AWS metadata fd00:ec2::254)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv6');
}

/** Expands an IPv6 address (optionally with a dotted IPv4 tail) into eight 16-bit groups. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (isIPv4(maybeV4)) {
    const [a = 0, b = 0, c = 0, d = 0] = maybeV4.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((h) => parseInt(h, 16)));
  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  const fill = 8 - left.length - right.length;
  if ((rest === undefined && fill !== 0) || fill < 0) return undefined;
  const groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

function v4FromGroups(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/** The IPv4 address embedded in an IPv6 address, if it uses a well-known embedding. */
function embeddedIPv4(groups: number[]): string | undefined {
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroPrefix && (g5 === 0xffff || g5 === 0)) return v4FromGroups(g6, g7); // mapped / compatible
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4FromGroups(g6, g7); // NAT64
  if (g0 === 0x2002) return v4FromGroups(g1 ?? 0, g2 ?? 0); // 6to4
  return undefined;
}

/** True only for a syntactically valid IPv4 or IPv6 address in public unicast space. */
export function isPublicIp(address: string): boolean {
  if (isIPv4(address)) return !NON_PUBLIC.check(address, 'ipv4');
  if (!isIPv6(address)) return false;
  if (NON_PUBLIC.check(address, 'ipv6')) return false;
  const groups = ipv6Groups(address);
  if (!groups) return false;
  const v4 = embeddedIPv4(groups);
  return v4 === undefined || !NON_PUBLIC.check(v4, 'ipv4');
}
