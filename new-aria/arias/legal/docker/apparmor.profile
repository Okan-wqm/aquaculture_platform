# SPDX-License-Identifier: Apache-2.0
# Adapted from https://github.com/moby/profiles/blob/main/apparmor/template.go
# Copyright The Moby Authors. ARIA additions: scoped userns and worker mount setup grants.
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

  # Bubblewrap 0.8 (image) / 0.9 (runner) setup, traced as a non-root user.
  # cap_drop=ALL + no-new-privileges remain required: mount authority exists
  # only inside the new user namespace. The worker drops those caps before exec.
  # Keep Docker system-path masks and every deny below; these grants cannot
  # override kernel restrictions on nested proc mounts (review finding 011).
  mount options=(rslave,silent) -> /,
  mount fstype=tmpfs options=(rw,nosuid,nodev) -> /tmp/,
  mount options=(rbind,silent) -> /tmp/newroot/,
  pivot_root oldroot=/tmp/oldroot/ /tmp/,
  mount options=(rbind,silent) -> /newroot/**,
  mount fstype=proc options=(rw,nosuid,nodev,noexec) -> /newroot/proc/,
  mount fstype=tmpfs options=(rw,nosuid,nodev) -> /newroot/{dev,tmp}/,
  mount fstype=devpts options=(rw,nosuid,noexec) -> /newroot/dev/pts/,
  # bind-mount.c preserves noexec and the source mount's three atime bits.
  # Enumerate them so remount+bind+nosuid+nodev are mandatory in every grant.
  mount options=(ro,remount,bind,nosuid,nodev,silent) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,relatime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,nodiratime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,nodiratime,relatime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,noatime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,noatime,relatime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,noatime,nodiratime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,noatime,nodiratime,relatime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,noexec) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,noexec,relatime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,noexec,nodiratime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,noexec,nodiratime,relatime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,noexec,noatime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,noexec,noatime,relatime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,noexec,noatime,nodiratime) -> /newroot/**,
  mount options=(ro,remount,bind,nosuid,nodev,silent,noexec,noatime,nodiratime,relatime) -> /newroot/**,
  mount options=(rw,remount,bind,nosuid,nodev,silent) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,relatime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,nodiratime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,nodiratime,relatime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,noatime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,noatime,relatime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,noatime,nodiratime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,noatime,nodiratime,relatime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,noexec) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,noexec,relatime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,noexec,nodiratime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,noexec,nodiratime,relatime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,noexec,noatime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,noexec,noatime,relatime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,noexec,noatime,nodiratime) -> /newroot/output/{,**},
  mount options=(rw,remount,bind,nosuid,nodev,silent,noexec,noatime,nodiratime,relatime) -> /newroot/output/{,**},
  mount options=(rprivate,silent) -> /oldroot/,
  pivot_root oldroot=/newroot/ /newroot/,

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
