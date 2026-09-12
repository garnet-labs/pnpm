// This action exists for its post step. Registering a main step after the
// Garnet action is what puts that post step ahead of Garnet's own, which is
// the only point where the sensor's stop can be observed while it is running.
console.log('jibril goroutine dump armed; the stop will be taken in this action post step')
