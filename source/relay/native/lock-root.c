#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/magic.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <strings.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/vfs.h>
#include <unistd.h>
#include <environment.h>

#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error Unsupported bootstrap architecture
#endif

static void refuse(void) {
    static const char message[] = "relay startup refused: lockdown\n";
    ssize_t written = write(STDERR_FILENO, message, sizeof(message) - 1);
    (void)written;
    _exit(125);
}

static int name_equals(const char *entry, size_t length, const char *name) {
    return strlen(name) == length && memcmp(entry, name, length) == 0;
}

static void validate_environment(char *const env[]) {
    if (!env) refuse();
    for (size_t i = 0; env[i]; i++) {
        const char *eq = strchr(env[i], '=');
        if (!eq || eq == env[i]) refuse();
        size_t length = (size_t)(eq - env[i]);
        for (size_t j = 0; j < i; j++) {
            const char *other = strchr(env[j], '=');
            if (other && (size_t)(other - env[j]) == length && memcmp(env[j], env[i], length) == 0) refuse();
        }
        if (eq[1] == '\0') continue;
        for (size_t j = 0; forbidden_prefixes[j]; j++)
            if (length >= strlen(forbidden_prefixes[j]) && memcmp(env[i], forbidden_prefixes[j], strlen(forbidden_prefixes[j])) == 0) refuse();
        for (size_t j = 0; forbidden_names[j]; j++)
            if (name_equals(env[i], length, forbidden_names[j])) refuse();
        for (size_t j = 0; forbidden_names_ignoring_case[j]; j++)
            if (strlen(forbidden_names_ignoring_case[j]) == length && strncasecmp(env[i], forbidden_names_ignoring_case[j], length) == 0) refuse();
        for (size_t j = 0; fixed_environment[j]; j++) {
            const char *fixed_eq = strchr(fixed_environment[j], '=');
            if ((size_t)(fixed_eq - fixed_environment[j]) == length && memcmp(env[i], fixed_environment[j], length) == 0 &&
                strcmp(env[i], fixed_environment[j]) != 0) refuse();
        }
        for (size_t j = 0; approved_environment[j]; j++) {
            const char *fixed_eq = strchr(approved_environment[j], '=');
            if ((size_t)(fixed_eq - approved_environment[j]) == length && memcmp(env[i], approved_environment[j], length) == 0 &&
                strcmp(env[i], approved_environment[j]) != 0) refuse();
        }
    }
}

static void close_descriptors(void) {
    if (syscall(SYS_close_range, 3U, ~0U, 0U) != 0) refuse();
    for (int fd = 0; fd < 3; fd++) {
        struct stat info;
        struct statfs filesystem;
        int flags = fcntl(fd, F_GETFL);
        if (flags < 0 || flags & O_PATH || fstat(fd, &info) != 0 || fstatfs(fd, &filesystem) != 0 || filesystem.f_type == NSFS_MAGIC) refuse();
        if (S_ISREG(info.st_mode)) {
            if ((flags & O_ACCMODE) != O_RDONLY) refuse();
        } else if (S_ISCHR(info.st_mode)) {
            // A container may attach stdin to /dev/null. Other device handles could retain authority.
            if (major(info.st_rdev) != 1 || minor(info.st_rdev) != 3) refuse();
        // A socket can hold SCM_RIGHTS descriptors even after every numbered descriptor is closed.
        } else if (!S_ISFIFO(info.st_mode)) refuse();
    }
}

static void get_capabilities(struct __user_cap_data_struct data[2]) {
    struct __user_cap_header_struct header = { _LINUX_CAPABILITY_VERSION_3, 0 };
    if (syscall(SYS_capget, &header, data) != 0) refuse();
}

static int last_capability(void) {
    for (int capability = 0; capability <= 64; capability++) {
        errno = 0;
        int value = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
        if (value == -1 && errno == EINVAL) return capability - 1;
        if (value != 0 && value != 1) refuse();
    }
    refuse();
    return -1;
}

static int initial_identity(void) {
    uid_t real_uid, effective_uid, saved_uid;
    gid_t real_gid, effective_gid, saved_gid;
    if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 || getresgid(&real_gid, &effective_gid, &saved_gid) != 0 ||
        real_uid || effective_uid || saved_uid || real_gid || effective_gid || saved_gid) refuse();
    struct __user_cap_data_struct data[2];
    get_capabilities(data);
    const unsigned required = (1U << CAP_SYS_ADMIN) | (1U << CAP_SETPCAP) | (1U << CAP_SETUID) | (1U << CAP_SETGID);
    if ((data[0].effective & required) != required || (data[0].permitted & required) != required) refuse();
    int last = last_capability();
    if (last < CAP_SYS_ADMIN || last >= 64) refuse();
    return last;
}

static void seal_root(void) {
    struct statvfs before, after;
    if (statvfs("/", &before) != 0) refuse();
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) refuse();
    const unsigned long restrictions = ST_RDONLY | ST_NOSUID | ST_NODEV | ST_NOEXEC | ST_SYNCHRONOUS | ST_MANDLOCK | ST_NOATIME | ST_NODIRATIME;
    const unsigned long preserved = before.f_flag & restrictions;
    // statvfs and mount use different bits for relatime.
    const unsigned long atime = (before.f_flag & ST_RELATIME) ? MS_RELATIME : (before.f_flag & ST_NOATIME) ? 0 : MS_STRICTATIME;
    const unsigned long symlinks = (before.f_flag & ST_NOSYMFOLLOW) ? MS_NOSYMFOLLOW : 0;
    if (mount(NULL, "/", NULL, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV | preserved | atime | symlinks, NULL) != 0) refuse();
    if (statvfs("/", &after) != 0 || (after.f_flag & (ST_RDONLY | ST_NOSUID | ST_NODEV)) != (ST_RDONLY | ST_NOSUID | ST_NODEV) ||
        (after.f_flag & preserved) != preserved ||
        (after.f_flag & (before.f_flag & (ST_RELATIME | ST_NOSYMFOLLOW))) != (before.f_flag & (ST_RELATIME | ST_NOSYMFOLLOW))) refuse();
}

static void remove_privileges(int last) {
    // Empty the bounding set while CAP_SETPCAP is still effective; dropping it first would strand entries.
    for (int capability = 0; capability <= last; capability++)
        if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0) refuse();
    // Groups and IDs need their current capabilities. Clear ambient authority before changing IDs,
    // then zero every capability set so neither saved root IDs nor a later exec can restore privilege.
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0 || setgroups(0, NULL) != 0 ||
        setresgid(65532, 65532, 65532) != 0 || setresuid(65532, 65532, 65532) != 0) refuse();
    struct __user_cap_header_struct header = { _LINUX_CAPABILITY_VERSION_3, 0 };
    struct __user_cap_data_struct data[2] = {{0}, {0}};
    if (syscall(SYS_capset, &header, data) != 0) refuse();
    uid_t real_uid, effective_uid, saved_uid;
    gid_t real_gid, effective_gid, saved_gid;
    if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 || getresgid(&real_gid, &effective_gid, &saved_gid) != 0 ||
        real_uid != 65532 || effective_uid != 65532 || saved_uid != 65532 || real_gid != 65532 || effective_gid != 65532 || saved_gid != 65532 ||
        getgroups(0, NULL) != 0) refuse();
    get_capabilities(data);
    for (int i = 0; i < 2; i++) if (data[i].effective || data[i].permitted || data[i].inheritable) refuse();
    for (int capability = 0; capability <= last; capability++)
        if (prctl(PR_CAPBSET_READ, capability, 0, 0, 0) != 0 ||
            prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, capability, 0, 0) != 0) refuse();
}

#define DENY_SYSCALL(name) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_##name, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static const struct sock_filter lockdown_filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    DENY_SYSCALL(mount), DENY_SYSCALL(umount2), DENY_SYSCALL(mount_setattr), DENY_SYSCALL(fsopen),
    DENY_SYSCALL(fsconfig), DENY_SYSCALL(fsmount), DENY_SYSCALL(fspick), DENY_SYSCALL(open_tree), DENY_SYSCALL(move_mount),
    DENY_SYSCALL(pivot_root), DENY_SYSCALL(chroot), DENY_SYSCALL(unshare), DENY_SYSCALL(setns), DENY_SYSCALL(ptrace),
    DENY_SYSCALL(process_vm_writev), DENY_SYSCALL(pidfd_getfd), DENY_SYSCALL(keyctl), DENY_SYSCALL(bpf),
    DENY_SYSCALL(userfaultfd), DENY_SYSCALL(perf_event_open),
    DENY_SYSCALL(io_uring_setup), DENY_SYSCALL(io_uring_enter), DENY_SYSCALL(io_uring_register),
    // clone3 hides namespace flags behind a pointer seccomp cannot inspect. ENOSYS makes libc
    // fall back to clone, whose flags we check below, so ordinary Node threads keep working.
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC |
        CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWTIME, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
};
#undef DENY_SYSCALL

static void install_filter(void) {
    struct sock_fprog program = { (unsigned short)(sizeof(lockdown_filter) / sizeof(lockdown_filter[0])), (struct sock_filter *)lockdown_filter };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1 ||
        prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0, 0) != 0 || prctl(PR_GET_SECCOMP, 0, 0, 0, 0) != SECCOMP_MODE_FILTER) refuse();
}

int main(int argc, char **argv, char **env) {
    if (argc != 1 || !argv || !argv[0] || strcmp(argv[0], "/app/lock-root") != 0 || argv[1] != NULL) refuse();
    close_descriptors();
    validate_environment(env);
    int last = initial_identity();
    seal_root();
    remove_privileges(last);
    install_filter();
    char *const node_argv[] = { "/nodejs/bin/node", "/app/runtime.mjs", NULL };
    execve(node_argv[0], node_argv, (char *const *)approved_environment);
    refuse();
    return 125;
}
