# SPDX-License-Identifier: Apache-2.0
# Adapted from https://github.com/moby/profiles/blob/main/apparmor/template.go
# Copyright The Moby Authors. ARIA additions: explicit userns and two mount grants.
# Load this separately on the dedicated Linux host before starting legal-ui.
# This file does not replace docker-default or change any host-wide policy.
abi <abi/4.0>,
#include <tunables/global>

profile aria-legal flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  network,
  network unix,
  deny network alg,
  deny network vsock,
  capability,
  file,
  userns,
  umount,
  signal (receive) peer=unconfined,
  signal (receive) peer=runc,
  signal (receive) peer=crun,
  signal (send,receive) peer=aria-legal,

  # The service has no host capabilities. These grants permit unshare to
  # prepare a private proc view after creating its unprivileged user namespace.
  mount options=(rprivate) -> /,
  mount fstype=proc options=(rw,nosuid,nodev,noexec) -> /proc/,

  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9/],[^1-9/][^0-9/],[^1-9s/][^0-9y/][^0-9s/],[^1-9/][^0-9/][^0-9/][^0-9/]*}/** w,
  deny @{PROC}/sys/[^k]** w,
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,
  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/devices/virtual/powercap/** rwklx,
  deny /sys/kernel/security/** rwklx,
  ptrace (trace,tracedby,read,readby) peer=aria-legal,
}
