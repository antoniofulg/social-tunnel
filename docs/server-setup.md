# Server setup: basic tunnel

This sets up the plain tunnel: a fixed domain list in a Chrome policy that you edit by hand. To add and remove domains from the app instead, install the [protected server package](../server/linux/README.md).

Do this once, as root on the server.

## 1. A tunnel user with no shell

```sh
useradd --create-home --shell /usr/sbin/nologin sotunnel
install -d -m 755 -o root -g root ~sotunnel/.ssh
```

Add the public half of the home computer's tunnel key to `~sotunnel/.ssh/authorized_keys`, limited to one remote listen and nothing else:

```
restrict,port-forwarding,permitlisten="127.0.0.1:8888",command="/usr/sbin/nologin" ssh-ed25519 AAAA... social-tunnel
```

Keep the folder and the file root-owned (`chown root:root`, `chmod 644` on the file) so the tunnel user cannot edit its own key restrictions. It still owns its home folder, but with no shell and no `sftp` it has no way to swap the root-owned `.ssh` folder for another. `sshd` accepts root-owned key files.

## 2. One `sshd` rule

Append to `/etc/ssh/sshd_config`, then reload `sshd`:

```
Match User sotunnel
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:8888
    PermitOpen none
    AllowStreamLocalForwarding no
    GatewayPorts no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    ForceCommand /usr/sbin/nologin
    ClientAliveInterval 30
    ClientAliveCountMax 3
```

The keepalive frees the port within about 90 seconds after the home computer drops off, so the tunnel can come back.

## 3. A Chrome policy that sends only the chosen domains to the tunnel

Point the agents' Chrome at a PAC through a managed policy, for example `/etc/opt/chrome/policies/managed/social-tunnel.json`:

```json
{
  "ProxySettings": {
    "ProxyMode": "pac_script",
    "ProxyPacUrl": "data:application/x-ns-proxy-autoconfig;base64,<base64 of the PAC below>",
    "ProxyPacMandatory": true
  }
}
```

```js
function FindProxyForURL(url, host) {
  var domains = ["instagram.com", "facebook.com", "threads.net", "linkedin.com", "tiktok.com"];
  host = host.toLowerCase();
  for (var i = 0; i < domains.length; i++) {
    if (host === domains[i] || dnsDomainIs(host, "." + domains[i])) return "PROXY 127.0.0.1:8888";
  }
  return "DIRECT";
}
```

`ProxyPacMandatory` keeps Chrome from going direct when the PAC cannot be used. Restart Chrome, or reload `chrome://policy`, to apply it. Keep the PAC list and the home config's `domains` the same. If your platform firewalls the agents from local ports, allow `tcp/8888` (on agentes.chat: `agentes-runner services allow tcp/8888`).

## 4. Pin the server's host key

Get the fingerprint from a trusted network and check it against the server's own `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`:

```sh
ssh-keyscan -p 22 -t ed25519 your.server | ssh-keygen -lf -
```

Put it in the home config's `server.hostKey`.
