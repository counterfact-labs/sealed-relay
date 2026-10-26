ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG SOURCE_DATE_EPOCH
# COPY --chmod would create missing parent folders without the search bit, so the relay user could not open its
# files. WORKDIR creates them root-owned and traversable; the files themselves stay read-only.
WORKDIR /opt/counterfact/bundle
WORKDIR /opt/counterfact/relay
WORKDIR /app
COPY --chown=0:0 --chmod=0444 runtime.mjs release.pub /app/
COPY --chown=0:0 --chmod=0444 sealed.json /opt/counterfact/bundle/sealed.json
COPY --chown=0:0 --chmod=0444 model-credential.enc /opt/counterfact/relay/model-credential.enc
COPY --chown=0:0 --chmod=0555 lock-root /app/lock-root
ENV NODE_ENV=production TMPDIR=/tmp
LABEL tee.launch_policy.allow_mount_destinations="/tmp"
LABEL tee.launch_policy.allow_capabilities="true"
LABEL tee.launch_policy.allow_cmd_override="false"
LABEL tee.launch_policy.allow_env_override=""
# Confidential Space opens only the ports an image exposes, so without this the relay cannot be reached.
EXPOSE 8443/tcp
USER 0:0
ENTRYPOINT ["/app/lock-root"]
CMD []
