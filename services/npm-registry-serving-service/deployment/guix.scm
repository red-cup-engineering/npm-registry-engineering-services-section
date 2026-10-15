;; A bounded registry release. RUNTIME is the packed application with its exact
;; registry dependencies installed by pnpm, never a source workspace.
(use-modules (guix gexp) (gnu packages node))
(let ((runtime (getenv "NPM_REGISTRY_RUNTIME"))
      (configuration (getenv "NPM_REGISTRY_CONFIGURATION")))
  (unless (and runtime configuration) (error "registry runtime and configuration required"))
  (computed-file "npm-registry-release"
    #~(begin
        (use-modules (guix build utils))
        (copy-recursively #$(local-file runtime "registry-runtime" #:recursive? #t) #$output)
        (copy-file #$(local-file configuration "registry.json")
                   (string-append #$output "/registry.json"))
        (mkdir-p (string-append #$output "/.guix-systemd"))
        (call-with-output-file (string-append #$output "/.guix-systemd/npm-registry.service")
          (lambda (port)
            (format port "[Unit]~%Description=House npm registry Guix release~%After=network-online.target~%[Service]~%Type=simple~%WorkingDirectory=~a~%ExecStart=~a/bin/node ~a/bin/serve.mjs ~a/registry.json~%Environment=NPM_REGISTRY_PORT=18821~%Restart=on-failure~%RestartSec=5~%MemoryHigh=192M~%UMask=0077~%" #$output #$node #$output #$output))))))
