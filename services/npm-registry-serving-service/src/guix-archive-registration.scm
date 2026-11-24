;; One process amortizes Guile startup across the registry inventory. Each
;; admission ends its own store connection after retaining its collector root.
(use-modules (guix store)
             (ice-9 format)
             (ice-9 rdelim)
             (json))

(define (register-archive source root)
  (unless (and (absolute-file-name? source)
               (equal? source (canonicalize-path source))
               (eq? 'regular (stat:type (lstat source)))
               (absolute-file-name? root)
               (equal? (dirname root) (canonicalize-path (dirname root))))
    (error "regular archive and unredirected collector root required"))
  (let ((archive
          (with-store connection
            (let ((archive (add-to-store connection "npm-registry-archive.tgz" #f "sha256" source)))
              (add-temp-root connection archive)
              (unless (valid-path? connection archive)
                (error "archive not registered in Guix"))
              ;; A concurrent retry may have created the same link. Never replace a
              ;; diverged link or a non-link, regardless of which publisher created it.
              (catch 'system-error
                (lambda () (symlink archive root))
                (lambda args
                  (unless (= EEXIST (system-error-errno args)) (apply throw args))))
              (let ((info (lstat root)))
                (unless (and (eq? 'symlink (stat:type info))
                             (= (getuid) (stat:uid info))
                             (equal? archive (readlink root))
                             (equal? archive (canonicalize-path root)))
                  (error "foreign or diverged archive collector root")))
              (add-indirect-root connection root)
              archive))))
    ;; Close the admission connection first. Its temporary root would otherwise
    ;; hide an unreadable permanent collector from the daemon's liveness query.
    (with-store connection
      (unless (member archive (live-paths connection))
        (error "archive collector is not visible to Guix garbage collection")))
    archive))

(let loop ()
  (let ((line (read-line)))
    (unless (eof-object? line)
      (let* ((request (json-string->scm line))
             (id (assoc-ref request "id"))
             (response
               (catch #t
                 (lambda ()
                   `(("id" . ,id)
                     ("archive" . ,(register-archive (assoc-ref request "file")
                                                     (assoc-ref request "root")))))
                 (lambda (key . details)
                   `(("id" . ,id)
                     ("error" . ,(format #f "Guix archive registration refused: ~a ~s" key details)))))))
        (display (scm->json-string response))
        (newline)
        (force-output))
      (loop))))
