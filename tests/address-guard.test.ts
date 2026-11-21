import { expect, test } from "bun:test";
import { isRefusedAddress } from "../src/address-guard";

const none = {};

test("[C12] the address guard refuses both ends of every listed range and accepts the neighbours", () => {
  // [first, last, address just below, address just above]; null where the neighbour is itself refused.
  const ranges: [string, string, string | null, string | null][] = [
    ["0.0.0.0", "0.255.255.255", null, "1.0.0.0"],
    ["10.0.0.0", "10.255.255.255", "9.255.255.255", "11.0.0.0"],
    ["100.64.0.0", "100.127.255.255", "100.63.255.255", "100.128.0.0"],
    ["127.0.0.0", "127.255.255.255", "126.255.255.255", "128.0.0.0"],
    ["169.254.0.0", "169.254.255.255", "169.253.255.255", "169.255.0.0"],
    ["172.16.0.0", "172.31.255.255", "172.15.255.255", "172.32.0.0"],
    ["192.0.0.0", "192.0.0.255", "191.255.255.255", "192.0.1.0"],
    ["192.168.0.0", "192.168.255.255", "192.167.255.255", "192.169.0.0"],
    ["198.18.0.0", "198.19.255.255", "198.17.255.255", "198.20.0.0"],
    ["224.0.0.0", "239.255.255.255", "223.255.255.255", null],
    ["240.0.0.0", "255.255.255.255", null, null],
    ["::", "::", null, null],
    ["::1", "::1", null, null],
    ["100::", "100::ffff:ffff:ffff:ffff", "ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "100:0:0:1::"],
    ["2001::", "2001:0:ffff:ffff:ffff:ffff:ffff:ffff", "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "2001:1::"],
    ["64:ff9b:1::", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff", "64:ff9b:0:ffff:ffff:ffff:ffff:ffff", "64:ff9b:2::"],
    ["fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe00::"],
    ["fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", null],
    ["fec0::", "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", null, null],
    ["ff00::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", null, null],
    // IPv4 carried inside IPv6: the embedded 10/8 is refused, its neighbours are not.
    ["::10.0.0.0", "::10.255.255.255", "::9.255.255.255", "::11.0.0.0"],
    ["::ffff:10.0.0.0", "::ffff:10.255.255.255", "::ffff:9.255.255.255", "::ffff:11.0.0.0"],
    ["64:ff9b::a00:0", "64:ff9b::aff:ffff", "64:ff9b::9ff:ffff", "64:ff9b::b00:0"],
    ["2002:a00::", "2002:aff:ffff:ffff:ffff:ffff:ffff:ffff", "2002:9ff:ffff:ffff:ffff:ffff:ffff:ffff", "2002:b00::"],
  ];
  for (const [first, last, below, above] of ranges) {
    expect([first, isRefusedAddress(first, none)]).toEqual([first, true]);
    expect([last, isRefusedAddress(last, none)]).toEqual([last, true]);
    if (below) expect([below, isRefusedAddress(below, none)]).toEqual([below, false]);
    if (above) expect([above, isRefusedAddress(above, none)]).toEqual([above, false]);
  }

  for (const address of ["157.240.1.1", "2a03:2880::1", "::ffff:157.240.1.1"]) {
    expect([address, isRefusedAddress(address, none)]).toEqual([address, false]);
  }
  for (const address of ["::ffff:10.0.0.1", "::10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::"]) {
    expect([address, isRefusedAddress(address, none)]).toEqual([address, true]);
  }
  // Fail closed on anything that is not an address.
  expect(isRefusedAddress("instagram.com", none)).toBe(true);
});

test("[C13] the address guard refuses addresses inside a prefix of a local interface", () => {
  const interfaces = {
    en0: [{ cidr: "203.0.113.7/24" }, { cidr: "2a03:2880:1:2:aaaa:bbbb:cccc:dddd/64" }],
  };
  // A device on the LAN with a public IPv6 address, and one on a public IPv4 subnet.
  expect(isRefusedAddress("2a03:2880:1:2::99", interfaces)).toBe(true);
  expect(isRefusedAddress("203.0.113.200", interfaces)).toBe(true);
  expect(isRefusedAddress("::ffff:203.0.113.200", interfaces)).toBe(true);
  // The neighbouring prefixes stay reachable, and so do the same addresses on another machine.
  expect(isRefusedAddress("2a03:2880:1:3::99", interfaces)).toBe(false);
  expect(isRefusedAddress("203.0.114.1", interfaces)).toBe(false);
  expect(isRefusedAddress("2a03:2880:1:2::99", none)).toBe(false);
  expect(isRefusedAddress("203.0.113.200", none)).toBe(false);
});
