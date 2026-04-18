import coreutils from "@rivet-dev/agent-os-coreutils";
import sed from "@rivet-dev/agent-os-sed";
import grep from "@rivet-dev/agent-os-grep";
import gawk from "@rivet-dev/agent-os-gawk";
import findutils from "@rivet-dev/agent-os-findutils";
import diffutils from "@rivet-dev/agent-os-diffutils";
import tar from "@rivet-dev/agent-os-tar";
import gzip from "@rivet-dev/agent-os-gzip";

const common = [coreutils, sed, grep, gawk, findutils, diffutils, tar, gzip];

export default common;
export { coreutils, sed, grep, gawk, findutils, diffutils, tar, gzip };
