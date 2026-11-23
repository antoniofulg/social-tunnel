// SPDX-License-Identifier: GPL-2.0-only
// Build for the reviewed host with literal port, UID and dedicated sshd cgroup inode.
// Root provisioner attaches both hooks to the initial cgroup-v2 root (no override).
#include <linux/bpf.h>
#include <linux/in.h>
#include <bpf/bpf_endian.h>
#include <bpf/bpf_helpers.h>

#if !defined(ST_PORT) || !defined(ST_UID) || !defined(ST_CGROUP)
#error "provide literal ST_PORT, ST_UID and ST_CGROUP"
#endif
_Static_assert(ST_PORT >= 1024 && ST_PORT <= 65535, "invalid forward port");
_Static_assert(ST_UID >= 1000, "invalid forward UID");
_Static_assert(ST_CGROUP > 0, "invalid dedicated cgroup");

SEC("cgroup/bind4")
int st_bind4(struct bpf_sock_addr *socket)
{
    if (socket->protocol != IPPROTO_TCP || socket->user_port != bpf_htons(ST_PORT))
        return 1;
    return socket->user_ip4 == bpf_htonl(0x7f000001) &&
        (__u32)bpf_get_current_uid_gid() == ST_UID && bpf_get_current_cgroup_id() == ST_CGROUP;
}

SEC("cgroup/bind6")
int st_bind6(struct bpf_sock_addr *socket)
{
    return socket->protocol != IPPROTO_TCP || socket->user_port != bpf_htons(ST_PORT);
}

char LICENSE[] SEC("license") = "GPL";
