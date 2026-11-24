// SPDX-License-Identifier: GPL-2.0-only
// Header-free equivalent of server/linux/domain-bind-guard.bpf.c for the VPS host.
// Literal port, forward UID and dedicated sshd cgroup inode; no maps.
#define SEC(name) __attribute__((section(name), used))
typedef unsigned int u32;
typedef unsigned long long u64;

#if !defined(ST_PORT) || !defined(ST_UID) || !defined(ST_CGROUP)
#error "provide literal ST_PORT, ST_UID and ST_CGROUP"
#endif

// UAPI layout of struct bpf_sock_addr (include/uapi/linux/bpf.h).
struct bpf_sock_addr {
    u32 user_family;
    u32 user_ip4;
    u32 user_ip6[4];
    u32 user_port;
    u32 family;
    u32 type;
    u32 protocol;
    u32 msg_src_ip4;
    u32 msg_src_ip6[4];
};

static u64 (* const get_current_uid_gid)(void) = (void *)15;
static u64 (* const get_current_cgroup_id)(void) = (void *)80;
#define IPPROTO_TCP 6
#define NET_PORT ((u32)__builtin_bswap16(ST_PORT))
#define NET_LOOPBACK ((u32)__builtin_bswap32(0x7f000001))

SEC("cgroup/bind4")
int st_bind4(struct bpf_sock_addr *socket)
{
    if (socket->protocol != IPPROTO_TCP || socket->user_port != NET_PORT)
        return 1;
    return socket->user_ip4 == NET_LOOPBACK &&
        (u32)get_current_uid_gid() == ST_UID && get_current_cgroup_id() == ST_CGROUP;
}

SEC("cgroup/bind6")
int st_bind6(struct bpf_sock_addr *socket)
{
    return socket->protocol != IPPROTO_TCP || socket->user_port != NET_PORT;
}

char LICENSE[] SEC("license") = "GPL";
