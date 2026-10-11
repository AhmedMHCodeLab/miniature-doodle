#!/usr/bin/env python3
"""Applies the two agreed fixes to .github/scripts/k8s-cleanup.sh (PR #81).
Run from the repo root on branch cleanup-k8s-aws-resources. Each edit must match exactly once."""
import sys
p = sys.argv[1] if len(sys.argv) > 1 else ".github/scripts/k8s-cleanup.sh"
s = open(p, encoding="utf-8").read()

def sub(old, new):
    global s
    if s.count(old) != 1:
        sys.exit(f"expected exactly 1 match, got {s.count(old)} for:\n{old[:120]}")
    s = s.replace(old, new)

# Fix 1: the workflow file is k8-cleanup.yaml
sub("--workflow k8s-cleanup.yaml", "--workflow k8-cleanup.yaml")

# Fix 3a: dns_records returns non-zero when the Route 53 call fails
sub('''  [ -n "${DNS_ZONE_ID:-}" ] || return 0
  aws route53 list-resource-record-sets --hosted-zone-id "$DNS_ZONE_ID" --output json \\
    | jq -r --arg o "$CLUSTER_NAME" '.ResourceRecordSets[] | select(.Type == "TXT")
        | select(any(.ResourceRecords[]?.Value; test("external-dns/owner=" + $o + "([,\\"]|$)"))) | .Name'
}''', '''  [ -n "${DNS_ZONE_ID:-}" ] || return 0
  local out
  out=$(aws route53 list-resource-record-sets --hosted-zone-id "$DNS_ZONE_ID" --output json) || return 1
  jq -r --arg o "$CLUSTER_NAME" '.ResourceRecordSets[] | select(.Type == "TXT")
        | select(any(.ResourceRecords[]?.Value; test("external-dns/owner=" + $o + "([,\\"]|$)"))) | .Name' <<<"$out"
}''')

# Fix 3b: aws_leftovers returns non-zero when any AWS lookup fails
sub('''aws_leftovers() {
  local arns id out
  arns=$(aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerArn' --output text)
  if [ -n "$arns" ] && [ "$arns" != None ]; then
    xargs -n 20 aws elbv2 describe-tags --output json --resource-arns <<<"$arns" \\
      | jq -r --arg c "$CLUSTER_NAME" '.TagDescriptions[]
          | select(any(.Tags[]; .Key == "elbv2.k8s.aws/cluster" and .Value == $c)) | "load-balancer \\(.ResourceArn)"'
  fi
  aws ec2 describe-security-groups --filters "Name=tag:elbv2.k8s.aws/cluster,Values=$CLUSTER_NAME" \\
    --query 'SecurityGroups[].GroupId' --output text | ids | sed 's/^/security-group /'
  aws ec2 describe-instances --filters "Name=tag:karpenter.sh/nodepool,Values=*" \\
    "Name=tag-key,Values=kubernetes.io/cluster/$CLUSTER_NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \\
    --query 'Reservations[].Instances[].InstanceId' --output text | ids | sed 's/^/karpenter-instance /'
''', '''# A failed AWS call must make this return non-zero, because "the call failed" is not the
# same as "nothing left". Pipes hide the failure, so each result is captured with || return 1.
aws_ids() {
  local prefix=$1 out
  shift
  out=$(aws "$@" --output text) || return 1
  ids <<<"$out" | sed "s/^/$prefix /"
}
aws_leftovers() {
  local arns id out
  arns=$(aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerArn' --output text) || return 1
  if [ -n "$arns" ] && [ "$arns" != None ]; then
    out=$(xargs -n 20 aws elbv2 describe-tags --output json --resource-arns <<<"$arns") || return 1
    jq -r --arg c "$CLUSTER_NAME" '.TagDescriptions[]
          | select(any(.Tags[]; .Key == "elbv2.k8s.aws/cluster" and .Value == $c)) | "load-balancer \\(.ResourceArn)"' <<<"$out" || return 1
  fi
  aws_ids security-group ec2 describe-security-groups --filters "Name=tag:elbv2.k8s.aws/cluster,Values=$CLUSTER_NAME" \\
    --query 'SecurityGroups[].GroupId' || return 1
  aws_ids karpenter-instance ec2 describe-instances --filters "Name=tag:karpenter.sh/nodepool,Values=*" \\
    "Name=tag-key,Values=kubernetes.io/cluster/$CLUSTER_NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \\
    --query 'Reservations[].Instances[].InstanceId' || return 1
''')

sub('''    aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=$VPC_ID" "Name=status,Values=available" \\
      --query 'NetworkInterfaces[].NetworkInterfaceId' --output text | ids | sed 's/^/detached-eni /'
''', '''    aws_ids detached-eni ec2 describe-network-interfaces --filters "Name=vpc-id,Values=$VPC_ID" "Name=status,Values=available" \\
      --query 'NetworkInterfaces[].NetworkInterfaceId' || return 1
''')
sub('''    aws ec2 describe-network-interfaces --filters "Name=tag:cluster.k8s.amazonaws.com/name,Values=$CLUSTER_NAME" \\
      --query 'NetworkInterfaces[].NetworkInterfaceId' --output text | ids | sed 's/^/eni /'
''', '''    aws_ids eni ec2 describe-network-interfaces --filters "Name=tag:cluster.k8s.amazonaws.com/name,Values=$CLUSTER_NAME" \\
      --query 'NetworkInterfaces[].NetworkInterfaceId' || return 1
''')
sub('''  dns_records | sed 's/^/dns-record /'
}''', '''  out=$(dns_records) || return 1
  [ -z "$out" ] || sed 's/^/dns-record /' <<<"$out"
  return 0
}''')

open(p, "w", encoding="utf-8").write(s)
print("patched", p)
