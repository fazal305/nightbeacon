#!/usr/bin/env bash
# Run this LOCALLY (with `gcloud` authenticated to your GCP account) to
# provision the Compute Engine VM and firewall rules for Nightbeacon.
#
# This is the only step that touches your GCP billing account — everything
# after this runs on the VM itself. Review the variables below before running.
set -euo pipefail

# --- Configure these ---
PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID to your GCP project id, e.g. export PROJECT_ID=my-project}"
ZONE="${ZONE:-asia-south1-a}"              # Mumbai — nearest GCP region to Pakistan with a Compute presence
VM_NAME="${VM_NAME:-nightbeacon-vm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-small}"    # 2 vCPU burst, 2GB RAM — enough for one operator, low volume
IMAGE_FAMILY="debian-12"
IMAGE_PROJECT="debian-cloud"
DISK_SIZE_GB="20"
SSH_SOURCE_IP="${SSH_SOURCE_IP:?Set SSH_SOURCE_IP to YOUR current public IP /32, e.g. export SSH_SOURCE_IP=203.0.113.5/32 — never leave SSH open to 0.0.0.0/0}"

gcloud config set project "$PROJECT_ID"

# Firewall: SSH only from your IP, HTTPS from anywhere. Postgres (5432) and
# the Express port (4000) are never exposed externally — nginx on the VM
# reverse-proxies 443 to the local Express process.
gcloud compute firewall-rules create nightbeacon-allow-ssh \
  --network=default \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:22 \
  --source-ranges="$SSH_SOURCE_IP" \
  --description="Nightbeacon: SSH from operator IP only" || true

gcloud compute firewall-rules create nightbeacon-allow-https \
  --network=default \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:443,tcp:80 \
  --source-ranges="0.0.0.0/0" \
  --description="Nightbeacon: HTTPS (80 required for Let's Encrypt HTTP-01 challenge)" || true

gcloud compute instances create "$VM_NAME" \
  --zone="$ZONE" \
  --machine-type="$MACHINE_TYPE" \
  --image-family="$IMAGE_FAMILY" \
  --image-project="$IMAGE_PROJECT" \
  --boot-disk-size="$DISK_SIZE_GB" \
  --tags=nightbeacon

echo
echo "VM created. Next steps (see docs/DEPLOYMENT.md for the full walkthrough):"
echo "1. gcloud compute ssh $VM_NAME --zone=$ZONE"
echo "2. Get the code onto the VM — this repo is private, so either:"
echo "     a) git clone with a GitHub personal access token (fine-grained, repo-scoped, short expiry), or"
echo "     b) gcloud compute scp --recurse . $VM_NAME:~/nightbeacon --zone=$ZONE (run locally)"
echo "3. On the VM: bash nightbeacon/deploy/02-setup-vm.sh"
echo "4. On the VM: bash nightbeacon/deploy/03-deploy.sh"
