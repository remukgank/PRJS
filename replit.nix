{ pkgs }:
{
  deps = [
    pkgs.systemd
    pkgs.opencode
    pkgs.speedtest-cli
    pkgs.chromium
    pkgs.aria2
    pkgs.axel
    pkgs.pm2
    pkgs.nano
    pkgs.cmake
    pkgs.gcc
    pkgs.boost
    pkgs.openssl
    pkgs.pkg-config
    pkgs.zlib
    pkgs.gperf
    pkgs.ripgrep
    pkgs.ffmpeg
  ];
}