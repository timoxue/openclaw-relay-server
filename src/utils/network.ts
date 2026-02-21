import net from 'net';

/**
 * Wait for a TCP port to be ready (TCP Ping)
 *
 * @param host - Hostname or IP address
 * @param port - Port number to check
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 30000)
 * @param retryIntervalMs - Interval between retry attempts in milliseconds (default: 500)
 * @returns Promise that resolves when port is ready
 * @throws Error if timeout is reached
 */
export async function waitForPort(
  host: string,
  port: number,
  timeoutMs: number = 30000,
  retryIntervalMs: number = 500
): Promise<void> {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const attemptConnection = () => {
      if (Date.now() - startTime > timeoutMs) {
        return reject(new Error(`Timeout waiting for ${host}:${port} to be ready`));
      }

      const socket = new net.Socket();
      socket.setTimeout(1000);

      socket.on('connect', () => {
        socket.destroy();
        resolve(); // Port is ready!
      });

      socket.on('timeout', () => {
        socket.destroy();
        setTimeout(attemptConnection, retryIntervalMs);
      });

      socket.on('error', () => {
        socket.destroy();
        setTimeout(attemptConnection, retryIntervalMs);
      });

      socket.connect(port, host);
    };

    attemptConnection();
  });
}
