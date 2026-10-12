That's the deploy key secret I flagged earlier. I'll confirm the exact name Terraform looks for.

The plan failed on the missing deploy key secret in Secrets Manager. It isn't a code problem and nothing is broken.

## What the error means
The plan found the staging cluster (`eks-v2-staging-cluster`) and planned ArgoCD fine. It stopped when it tried to read the secret `eks-v2-staging-argocd-deploy-key`. The error "couldn't find resource" means that secret doesn't exist in the AWS account and region the staging role uses.

`infra/argocd-bootstrap/main.tf` says this secret is "Created once by hand (outside Terraform, so it survives destroy)". Terraform never creates it. Dev probably worked because someone created that one earlier. The name is `<project_name>-<environment>-argocd-deploy-key`, so staging needs its own.

## Fix (about 2 minutes)
**1. Make a deploy key** (if you don't already have the dev one's private key to reuse):
```bash
ssh-keygen -t ed25519 -f ./staging-deploy-key -N "" -C "argocd-staging"
```

**2. Add the public key to GitHub:** repo → Settings → Deploy keys → Add key, paste `staging-deploy-key.pub`, leave "Allow write access" unticked (read-only).

*If the dev key already exists in the repo, you can reuse the same key pair for staging and skip this. One read-only key can serve all three environments.*

**3. Store the private key in Secrets Manager.** The secret name has to match exactly, in the same region as the cluster (`eu-west-2`):
```bash
aws secretsmanager create-secret \
  --region eu-west-2 \
  --name eks-v2-staging-argocd-deploy-key \
  --secret-string file://./staging-deploy-key
```
You'll need an identity allowed to create secrets in that account. Check it's the right account with `aws sts get-caller-identity`. The repo's README step 2 is the same command for dev.

**4. Re-run the ArgoCD Bootstrap plan** (staging, run ID empty). The plan should now finish. It will show more than the "1 to add" it showed this time, because the repo secret and root app resources couldn't be planned before the secret existed.

## Two things to watch
- **KMS:** if your team's secrets are normally encrypted with the project's KMS key, you can pass `--kms-key-id`. The ephemeral read works either way as long as the pipeline role is allowed to decrypt.
- **Same plan problem later:** the apply uses the plan from the run you paste, so after the fix use the run ID from the new successful plan, not the failed one.

If the plan fails again with an AccessDenied rather than "couldn't find", the secret exists but the staging pipeline role can't read it. Send me the new error and I'll work out which permission is missing.