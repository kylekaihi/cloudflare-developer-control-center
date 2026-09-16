# Backup, restore, and failure drills

## Recovery objectives

- Worker/Pages configuration rollback target: captured immediately before every deployment.
- D1 recovery point: pre-change Time Travel bookmark plus SQL export when the database exists.
- VPS recovery point: previous content-addressed code and environment release on each node.
- Secrets: never included in backup archives. Keep them in the operator's password manager.

## Create a backup

With the Cloudflare environment loaded:

```sh
npm run backup:control-center
```

The output directory under `.control-center/backups/` contains a mode-`0600` manifest and, when D1 already exists, a full SQL export with a SHA-256 checksum. The manifest records Worker/Pages IDs, a D1 Time Travel bookmark, and a redacted Access configuration snapshot. A deployment invokes this backup automatically before its first mutation.

Copy backups to encrypted storage according to your retention policy. Do not commit them: Access policies can contain operator email addresses and the SQL export contains monitoring history.

## Restore versioned components

Use an absolute backup directory and explicit confirmation:

```sh
npm run restore:control-center -- \
  /absolute/path/to/.control-center/backups/<backup-id> \
  --confirm=RESTORE_CONTROL_CENTER
```

This restores Pages and Worker versions but deliberately leaves D1 unchanged. To restore D1 to the pre-change bookmark, accept that newer monitoring samples and incident changes will be lost, then add:

```sh
--restore-d1
```

The SQL export is an independent recovery artifact and is checksum-verified before any restore begins. Access configuration is evidence only and is not overwritten automatically, avoiding accidental identity lockout.

## Quarterly failure drill

Run in staging or a documented maintenance window:

1. Create a backup and verify its manifest/file permissions and SQL checksum.
2. Deploy the same VPS release twice; confirm the second run reports `unchanged`.
3. Temporarily point one staging health check at an unused private port; confirm a pending incident opens only after the configured window.
4. Restore the endpoint and confirm one recovery transition.
5. Perform a service-token `prepare`, verify all configured reachable nodes, then `abort`.
6. Deploy a harmless Worker version, restore the prior Worker/Pages backup, and run post-deploy verification.
7. Test D1 restore only against a disposable database or staging copy.
8. Record timestamps, request IDs, recovery duration, surprises, and follow-up owners.

Never test a destructive D1 restore against production merely to satisfy the drill.
