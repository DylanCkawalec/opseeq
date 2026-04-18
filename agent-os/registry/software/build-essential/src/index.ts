import common from "@rivet-dev/agent-os-common";
import make from "@rivet-dev/agent-os-make";
import git from "@rivet-dev/agent-os-git";

const buildEssential = [...common, make, git];

export default buildEssential;
export { common, make, git };
