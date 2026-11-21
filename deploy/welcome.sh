# shellcheck shell=sh
# Restream login message (installed as /etc/profile.d/zz-restream-welcome.sh).
# For root: the address, user name and password of the first administrator (until that file is deleted),
# afterwards only the address.
restream_welcome() {
  case $- in *i*) ;; *) return 0 ;; esac
  [ "$(id -u)" = 0 ] || return 0
  if [ -f /etc/restream/firstboot-pending ]; then
    if [ -f /var/lib/restream/firstboot-failed ]; then
      printf '\n\033[31mRestream setup failed.\033[0m See /var/log/restream-firstboot.log, fix the cause and run: systemctl restart restream-firstboot\n\n'
    else
      printf '\n\033[36mRestream is being set up (this takes a minute or two).\033[0m Follow it with: tail -f /var/log/restream-firstboot.log\n\n'
    fi
    return 0
  fi
  if [ -r /root/restream-credentials.txt ]; then
    printf '\n\033[36mRestream\033[0m\n'; cat /root/restream-credentials.txt; echo
  elif [ -r /etc/restream/restream.env ]; then
    url=$(sed -n 's/^PUBLIC_URL=//p' /etc/restream/restream.env | tail -1)
    [ -n "$url" ] && printf '\nRestream: %s\n\n' "$url"
  fi
  return 0
}
restream_welcome
unset -f restream_welcome
