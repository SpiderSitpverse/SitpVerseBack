"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BusAlreadyInServiceError = exports.BusNotInServiceError = exports.Bus = void 0;
const bus_status_enum_1 = require("../value-objects/bus-status.enum");
class Bus {
    constructor(props) {
        this.props = props;
    }
    static fromPersistence(props) {
        return new Bus(props);
    }
    get id() {
        return this.props.id;
    }
    get plate() {
        return this.props.plate;
    }
    get route() {
        return this.props.route;
    }
    get driver() {
        return this.props.driver ?? null;
    }
    get status() {
        return this.props.status;
    }
    get latitude() {
        return this.props.latitude ?? null;
    }
    get longitude() {
        return this.props.longitude ?? null;
    }
    get updatedAt() {
        return this.props.updatedAt;
    }
    startTrip() {
        if (this.props.status === bus_status_enum_1.BusStatus.IN_SERVICE) {
            throw new BusAlreadyInServiceError(this.props.plate);
        }
        this.props.status = bus_status_enum_1.BusStatus.IN_SERVICE;
        this.props.updatedAt = new Date();
    }
    updatePosition(latitude, longitude) {
        if (this.props.status !== bus_status_enum_1.BusStatus.IN_SERVICE) {
            throw new BusNotInServiceError(this.props.plate);
        }
        this.props.latitude = latitude;
        this.props.longitude = longitude;
        this.props.updatedAt = new Date();
    }
    finishTrip() {
        if (this.props.status !== bus_status_enum_1.BusStatus.IN_SERVICE) {
            throw new BusNotInServiceError(this.props.plate);
        }
        this.props.status = bus_status_enum_1.BusStatus.FINISHED;
        this.props.updatedAt = new Date();
    }
    toPersistence() {
        return { ...this.props };
    }
}
exports.Bus = Bus;
class BusNotInServiceError extends Error {
    constructor(plate) {
        super(`El bus ${plate} no está en servicio.`);
        this.name = 'BusNotInServiceError';
    }
}
exports.BusNotInServiceError = BusNotInServiceError;
class BusAlreadyInServiceError extends Error {
    constructor(plate) {
        super(`El bus ${plate} ya está en servicio.`);
        this.name = 'BusAlreadyInServiceError';
    }
}
exports.BusAlreadyInServiceError = BusAlreadyInServiceError;
//# sourceMappingURL=bus.entity.js.map