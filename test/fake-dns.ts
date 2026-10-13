// A fixed name table standing in for DNS, so the URL guard's tests never ask a real resolver.
// Names that are not in the table fail like NXDOMAIN; names starting with `slow` never answer, and
// names starting with `lag` answer a public address after 800 ms.
const TABLE: Record<string, string[]> = {
	"public.test": ["93.184.215.14"],
	"www.public.test": ["93.184.215.14"],
	"other.test": ["93.184.215.15"],
	"internal.test": ["10.0.0.5"],
	"www.internal.test": ["10.0.0.6"],
	"mixed.test": ["93.184.215.14", "127.0.0.1"],
	"v6internal.test": ["2606:4700::6810:84e5", "fd00::1"],
	"metadata.test": ["169.254.169.254"],
	"example.com": ["93.184.215.16"],
	"docs.example.com": ["93.184.215.17"],
	"notexample.com": ["93.184.215.18"],
	"sub.evil.example": ["93.184.215.19"],
};

/** Names the fake resolver was asked for, in order. */
export const asked: string[] = [];

export async function fakeResolve(host: string): Promise<string[]> {
	asked.push(host);
	if (host.startsWith("slow")) return new Promise<string[]>(() => {});
	if (host.startsWith("lag")) {
		await Bun.sleep(800);
		return ["93.184.215.20"];
	}
	const answer = TABLE[host];
	if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
	return answer;
}
